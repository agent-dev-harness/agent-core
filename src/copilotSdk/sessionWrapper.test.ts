import { describe, it, expect, vi } from 'vitest';
import { SessionWrapper } from './sessionWrapper';
import type { CopilotClient, CopilotSession, PermissionRequest, SessionConfig } from './boundary';

type FakeConfig = SessionConfig & { autoApproveAll?: boolean };

function fakeClient(): {
  client: CopilotClient;
  createCalls: FakeConfig[];
  resumeCalls: { sessionId: string; config: FakeConfig }[];
  sessions: CopilotSession[];
} {
  const createCalls: FakeConfig[] = [];
  const resumeCalls: { sessionId: string; config: FakeConfig }[] = [];
  const sessions: CopilotSession[] = [];
  let nextId = 0;

  function fakeSession(sessionId: string): CopilotSession {
    const session = {
      sessionId,
      sendAndWait: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(() => () => {}),
      abort: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      setModel: vi.fn().mockResolvedValue(undefined),
    } as unknown as CopilotSession;
    sessions.push(session);
    return session;
  }

  const client = {
    createSession: vi.fn(async (config: FakeConfig) => {
      createCalls.push(config);
      return fakeSession(`session-${nextId++}`);
    }),
    resumeSession: vi.fn(async (sessionId: string, config: FakeConfig) => {
      resumeCalls.push({ sessionId, config });
      return fakeSession(sessionId);
    }),
  } as unknown as CopilotClient;

  return { client, createCalls, resumeCalls, sessions };
}

function shellRequest(): PermissionRequest {
  return { kind: 'shell' } as PermissionRequest;
}

function writeRequest(): PermissionRequest {
  return { kind: 'write' } as PermissionRequest;
}

function readRequest(): PermissionRequest {
  return { kind: 'read' } as PermissionRequest;
}

function customToolRequest(toolName: string): PermissionRequest {
  return { kind: 'custom-tool', toolName } as PermissionRequest;
}

function fakeTool(name: string) {
  return {
    name,
    description: `fake tool ${name}`,
    parameters: {},
    handler: vi.fn(async () => 'ok'),
  };
}

describe('SessionWrapper._createConfig (schema is fixed at construction)', () => {
  it('with zero tools: availableTools is empty and every candidate is denied', async () => {
    const wrapper = new SessionWrapper();
    const config = wrapper._createConfig();

    expect(config.availableTools).toEqual([]);
    expect(config.autoApproveAll).toBe(false);
    await expect(config.onPermissionRequest(writeRequest(), { sessionId: 's1' })).resolves.toMatchObject({
      kind: 'reject',
    });
  });

  it('with one built-in tool: availableTools and permission agree, and both stay true after a later disableTools call', async () => {
    const wrapper = new SessionWrapper(undefined, { builtins: ['edit'] });
    const config = wrapper._createConfig();

    expect(config.availableTools).toEqual(['edit']);
    await expect(config.onPermissionRequest(writeRequest(), { sessionId: 's1' })).resolves.toEqual({
      kind: 'approve-once',
    });
    await expect(config.onPermissionRequest(readRequest(), { sessionId: 's1' })).resolves.toMatchObject({
      kind: 'reject',
    });

    wrapper.disableTools('edit');
    const configAfterDisable = wrapper._createConfig();
    expect(configAfterDisable.availableTools).toEqual(['edit']);
    await expect(
      configAfterDisable.onPermissionRequest(writeRequest(), { sessionId: 's1' })
    ).resolves.toMatchObject({ kind: 'reject' });
  });

  it('with N mixed built-in and custom tools: every candidate resolves consistently', async () => {
    const tool = fakeTool('my_custom_tool');
    const wrapper = new SessionWrapper(undefined, {
      builtins: ['view', 'grep', 'glob', 'edit'],
      custom: [tool],
    });
    const config = wrapper._createConfig();

    expect(config.availableTools).toEqual(['view', 'grep', 'glob', 'edit', 'my_custom_tool']);
    expect(config.tools).toEqual([{ ...tool, handler: expect.any(Function) }]);
    for (const req of [writeRequest(), readRequest(), customToolRequest('my_custom_tool')]) {
      await expect(config.onPermissionRequest(req, { sessionId: 's1' })).resolves.toEqual({
        kind: 'approve-once',
      });
    }
    await expect(config.onPermissionRequest(customToolRequest('unlisted_tool'), { sessionId: 's1' })).resolves.toMatchObject({
      kind: 'reject',
    });
  });

  it('approval is per-call, not a standing grant: repeated calls to an enabled tool are each independently approved', async () => {
    const wrapper = new SessionWrapper(undefined, { builtins: ['edit'] });
    const config = wrapper._createConfig();

    await expect(config.onPermissionRequest(writeRequest(), { sessionId: 's1' })).resolves.toEqual({
      kind: 'approve-once',
    });
    await expect(config.onPermissionRequest(writeRequest(), { sessionId: 's1' })).resolves.toEqual({
      kind: 'approve-once',
    });
  });

  it('all construction-time tools are enabled by default', async () => {
    const wrapper = new SessionWrapper(undefined, { builtins: ['edit', 'view'] });
    const config = wrapper._createConfig();

    await expect(config.onPermissionRequest(writeRequest(), { sessionId: 's1' })).resolves.toEqual({
      kind: 'approve-once',
    });
    await expect(config.onPermissionRequest(readRequest(), { sessionId: 's1' })).resolves.toEqual({
      kind: 'approve-once',
    });
  });
});

describe('SessionWrapper permission-kind derivation (regression coverage)', () => {
  it.each([
    { builtin: 'view', request: readRequest(), kindLabel: 'read' },
    { builtin: 'grep', request: readRequest(), kindLabel: 'read' },
    { builtin: 'glob', request: readRequest(), kindLabel: 'read' },
    { builtin: 'edit', request: { kind: 'write' } as PermissionRequest, kindLabel: 'write' },
  ])('built-in "$builtin" round-trips to permission kind "$kindLabel"', async ({ builtin, request }) => {
    const wrapper = new SessionWrapper(undefined, { builtins: [builtin] });
    const config = wrapper._createConfig();

    expect(config.availableTools).toEqual([builtin]);
    await expect(config.onPermissionRequest(request, { sessionId: 's1' })).resolves.toEqual({
      kind: 'approve-once',
    });
  });

  it('a name with no known built-in mapping (custom/MCP/hook tool name) passes through unchanged', async () => {
    const wrapper = new SessionWrapper(undefined, { builtins: [], custom: [fakeTool('github-list_issues')] });
    const config = wrapper._createConfig();

    await expect(
      config.onPermissionRequest(customToolRequest('github-list_issues'), { sessionId: 's1' })
    ).resolves.toEqual({ kind: 'approve-once' });
    await expect(
      config.onPermissionRequest(customToolRequest('some_other_unlisted_tool'), { sessionId: 's1' })
    ).resolves.toMatchObject({ kind: 'reject' });
  });
});

describe('SessionWrapper.enableTools/disableTools', () => {
  it('disableTools denies at the permission layer without touching availableTools/tools', async () => {
    const wrapper = new SessionWrapper(undefined, { builtins: ['edit'] });
    wrapper.disableTools('edit');
    const config = wrapper._createConfig();

    expect(config.availableTools).toEqual(['edit']);
    await expect(config.onPermissionRequest(writeRequest(), { sessionId: 's1' })).resolves.toMatchObject({
      kind: 'reject',
    });
  });

  it('enableTools re-allows a previously-disabled tool', async () => {
    const wrapper = new SessionWrapper(undefined, { builtins: ['edit'] });
    wrapper.disableTools('edit').enableTools('edit');
    const config = wrapper._createConfig();

    await expect(config.onPermissionRequest(writeRequest(), { sessionId: 's1' })).resolves.toEqual({
      kind: 'approve-once',
    });
  });

  it('a custom tool can be disabled and re-enabled the same way as a built-in', async () => {
    const tool = fakeTool('run_gh_command');
    const wrapper = new SessionWrapper(undefined, { custom: [tool] });
    wrapper.disableTools('run_gh_command');
    const config = wrapper._createConfig();

    expect(config.availableTools).toEqual(['run_gh_command']);
    expect(config.tools).toEqual([{ ...tool, handler: expect.any(Function) }]);
    await expect(
      config.onPermissionRequest(customToolRequest('run_gh_command'), { sessionId: 's1' })
    ).resolves.toMatchObject({ kind: 'reject' });
  });

  it('throws synchronously on an unknown tool name and applies no partial state change', () => {
    const wrapper = new SessionWrapper(undefined, { builtins: ['edit', 'view'] });

    expect(() => wrapper.disableTools('edit', 'unknown_tool')).toThrow(/unknown tool/);

    const config = wrapper._createConfig();
    return expect(config.onPermissionRequest(writeRequest(), { sessionId: 's1' })).resolves.toEqual({
      kind: 'approve-once',
    });
  });

  it('enableTools with an unknown name also throws synchronously, atomically', () => {
    const wrapper = new SessionWrapper(undefined, { builtins: ['edit'] });
    wrapper.disableTools('edit');

    expect(() => wrapper.enableTools('edit', 'unknown_tool')).toThrow(/unknown tool/);

    const config = wrapper._createConfig();
    return expect(config.onPermissionRequest(writeRequest(), { sessionId: 's1' })).resolves.toMatchObject({
      kind: 'reject',
    });
  });

  it('a name never supplied at construction cannot be enabled -- there is no post-construction way to add a tool', () => {
    const wrapper = new SessionWrapper(undefined, { builtins: ['edit'] });
    expect(() => wrapper.enableTools('view')).toThrow(/unknown tool/);
    expect(wrapper._createConfig().availableTools).toEqual(['edit']);
  });
});

describe('SessionWrapper.abort and disconnect', () => {
  it('abort() aborts the current turn of the SDK session', async () => {
    const { client, sessions } = fakeClient();
    const wrapper = new SessionWrapper(client).setModelName('claude-sonnet-4.5');
    await wrapper.sendAndWait('turn one');
    await wrapper.abort();
    expect(sessions[0]?.abort).toHaveBeenCalledTimes(1);
  });

  it('disconnect() ends the SDK session, and the next turn creates a fresh one instead of resuming it', async () => {
    const { client, sessions, createCalls, resumeCalls } = fakeClient();
    const wrapper = new SessionWrapper(client).setModelName('claude-sonnet-4.5');
    await wrapper.sendAndWait('turn one');
    await wrapper.disconnect();
    expect(sessions[0]?.disconnect).toHaveBeenCalledTimes(1);
    expect(wrapper.session).toBeUndefined();

    await wrapper.sendAndWait('turn two');
    expect(createCalls).toHaveLength(2);
    expect(resumeCalls).toHaveLength(0);
  });

  it('both are safe to call before any session exists', async () => {
    const wrapper = new SessionWrapper(fakeClient().client);
    await expect(wrapper.abort()).resolves.toBeUndefined();
    await expect(wrapper.disconnect()).resolves.toBeUndefined();
  });
});

describe('SessionWrapper.sendAndWait: construction/resume lifecycle', () => {
  it("passes custom tools a turn signal that fires when the session's turn is aborted", async () => {
    const { client, sessions } = fakeClient();
    const original = vi.fn(async (_args: unknown, _invocation: unknown) => 'ok');
    const wrapper = new SessionWrapper(client, { custom: [{ name: 'slow', handler: original }] }).setModelName(
      'claude-sonnet-4.5'
    );
    const invocation = { sessionId: 's', toolCallId: 'c1', toolName: 'slow', arguments: {} };
    const wrapped = wrapper._createConfig().tools?.[0]?.handler;
    const passedSignal = (call: number) =>
      (original.mock.calls[call]?.[1] as { abortSignal: AbortSignal }).abortSignal;

    await wrapper.sendAndWait('turn one');
    await wrapped?.({ x: 1 }, invocation);
    expect(original).toHaveBeenLastCalledWith({ x: 1 }, expect.objectContaining(invocation));
    expect(passedSignal(0).aborted).toBe(false);

    const [listener] = vi.mocked(sessions[0]!.on).mock.calls[0] as unknown as [(event: { type: string }) => void];
    listener({ type: 'assistant.message' });
    expect(passedSignal(0).aborted).toBe(false);
    listener({ type: 'abort' });
    expect(passedSignal(0).aborted).toBe(true);

    await wrapper.sendAndWait('turn two');
    await wrapped?.({}, invocation);
    expect(passedSignal(1).aborted).toBe(false);
  });


  it('waits with no practical deadline unless the caller gives a timeout', async () => {
    const { client, sessions } = fakeClient();
    const wrapper = new SessionWrapper(client).setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    await wrapper.sendAndWait('turn two', 5000);

    expect(sessions[0]?.sendAndWait).toHaveBeenCalledWith(expect.any(String), 2 ** 31 - 1);
    expect(sessions[1]?.sendAndWait).toHaveBeenCalledWith(expect.any(String), 5000);
  });

  it('the first call always creates; a second call on the same instance resumes', async () => {
    const { client, createCalls, resumeCalls } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['edit'] }).setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    expect(createCalls).toHaveLength(1);
    expect(resumeCalls).toHaveLength(0);

    await wrapper.sendAndWait('turn two');
    expect(createCalls).toHaveLength(1);
    expect(resumeCalls).toHaveLength(1);
    expect(resumeCalls[0]?.sessionId).toBe('session-0');
  });

  it('resume sends onPermissionRequest, autoApproveAll: false, and the SDK-mandatory tools/availableTools/systemMessage -- no model or other base-config fields', async () => {
    const { client, resumeCalls } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['edit'] }, { workingDirectory: '/tmp/work' })
      .setSystemPrompt('be terse')
      .setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    await wrapper.sendAndWait('turn two');

    const resumeConfig = resumeCalls[0]?.config;
    expect(resumeConfig?.onPermissionRequest).toBeDefined();
    expect(resumeConfig?.autoApproveAll).toBe(false);
    expect(Object.keys(resumeConfig ?? {}).sort()).toEqual([
      'autoApproveAll',
      'availableTools',
      'onPermissionRequest',
      'systemMessage',
      'tools',
    ]);
  });

  it('the wire-level tools schema is byte-identical between create and every resume, even after enableTools/disableTools', async () => {
    const { client, createCalls, resumeCalls } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['edit', 'view'] }).setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    wrapper.disableTools('edit').enableTools('edit').disableTools('view');
    await wrapper.sendAndWait('turn two');

    expect(createCalls[0]?.availableTools).toEqual(['edit', 'view']);
    expect(resumeCalls[0]?.config?.availableTools).toEqual(['edit', 'view']);
    expect(resumeCalls[0]?.config?.tools).toEqual(createCalls[0]?.tools);
  });
});

describe('SessionWrapper.sendAndWait: systemMessage', () => {
  it('is sent in customize mode, carrying the caller instructions, and resent byte-identical on resume', async () => {
    const { client, createCalls, resumeCalls } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['edit'] })
      .setSystemPrompt('you are an auditor')
      .setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    await wrapper.sendAndWait('turn two');

    expect(createCalls[0]?.systemMessage?.mode).toBe('customize');
    expect(createCalls[0]?.systemMessage?.content).toContain('you are an auditor');
    expect(resumeCalls[0]?.config.systemMessage).toEqual(createCalls[0]?.systemMessage);
  });

  it('stays byte-identical across every resume even if setSystemPrompt is called again mid-session', async () => {
    const { client, createCalls, resumeCalls } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['edit'] })
      .setSystemPrompt('initial')
      .setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    wrapper.setSystemPrompt('changed');
    await wrapper.sendAndWait('turn two');
    await wrapper.sendAndWait('turn three');

    expect(resumeCalls[0]?.config.systemMessage).toEqual(createCalls[0]?.systemMessage);
    expect(resumeCalls[1]?.config.systemMessage).toEqual(createCalls[0]?.systemMessage);
    expect(resumeCalls[0]?.config.systemMessage?.content).not.toContain('changed');
  });

  it('setSystemPrompt after the session has started does not change what was already frozen at creation', async () => {
    const { client, createCalls } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['edit'] })
      .setSystemPrompt('initial')
      .setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    wrapper.setSystemPrompt('changed');

    expect(createCalls[0]?.systemMessage?.content).toContain('initial');
    expect(wrapper._createConfig().systemMessage?.content).toContain('initial');
    expect(wrapper._createConfig().systemMessage?.content).not.toContain('changed');
  });
});

describe('SessionWrapper.sendAndWait: per-turn enablement notice', () => {
  it('is prepended on the very first turn, before any mutation has happened', async () => {
    const { client, sessions } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['edit', 'view'] }).setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');

    const firstSendAndWait = sessions[0]?.sendAndWait as ReturnType<typeof vi.fn>;
    const firstPrompt = firstSendAndWait.mock.calls[0]?.[0] as string;
    expect(firstPrompt).toContain('Tools enabled this turn');
    expect(firstPrompt).toContain('edit, view');
    expect(firstPrompt.endsWith('turn one')).toBe(true);
  });

  it('is present again on the second turn even when nothing changed', async () => {
    const { client, sessions } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['edit'] }).setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    await wrapper.sendAndWait('turn two');

    const resumedSendAndWait = sessions[1]?.sendAndWait as ReturnType<typeof vi.fn>;
    const secondPrompt = resumedSendAndWait.mock.calls[0]?.[0] as string;
    expect(secondPrompt).toContain('Tools enabled this turn');
    expect(secondPrompt.endsWith('turn two')).toBe(true);
  });

  it('reflects a disableTools call made between turns', async () => {
    const { client, sessions } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['edit', 'view'] }).setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    wrapper.disableTools('view');
    await wrapper.sendAndWait('turn two');

    const resumedSendAndWait = sessions[1]?.sendAndWait as ReturnType<typeof vi.fn>;
    const secondPrompt = resumedSendAndWait.mock.calls[0]?.[0] as string;
    expect(secondPrompt).toContain('Only the following tools are currently enabled and may be called: edit.');
  });

  it('states that no tools are enabled when the subset is empty', async () => {
    const { client, sessions } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['edit'] }).setModelName('claude-sonnet-4.5');
    wrapper.disableTools('edit');

    await wrapper.sendAndWait('turn one');

    const firstSendAndWait = sessions[0]?.sendAndWait as ReturnType<typeof vi.fn>;
    const firstPrompt = firstSendAndWait.mock.calls[0]?.[0] as string;
    expect(firstPrompt).toContain('No tools are currently enabled');
  });

  it('prepends into MessageOptions.prompt rather than dropping the rest of the options', async () => {
    const { client, sessions } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['edit'] }).setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait({ prompt: 'turn one', attachments: [{ type: 'file', path: '/tmp/x.txt' }] } as never);

    const firstSendAndWait = sessions[0]?.sendAndWait as ReturnType<typeof vi.fn>;
    const firstOptions = firstSendAndWait.mock.calls[0]?.[0] as { prompt: string; attachments: unknown[] };
    expect(firstOptions.prompt).toContain('Tools enabled this turn');
    expect(firstOptions.prompt.endsWith('turn one')).toBe(true);
    expect(firstOptions.attachments).toEqual([{ type: 'file', path: '/tmp/x.txt' }]);
  });

  it('also relays a system-prompt-only change as a distinct notice', async () => {
    const { client, sessions } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['edit'] })
      .setSystemPrompt('be terse')
      .setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    wrapper.setSystemPrompt('be verbose');
    await wrapper.sendAndWait('turn two');

    const resumedSendAndWait = sessions[1]?.sendAndWait as ReturnType<typeof vi.fn>;
    const secondPrompt = resumedSendAndWait.mock.calls[0]?.[0] as string;
    expect(secondPrompt).toContain("additional operating instructions changed");
    expect(secondPrompt).toContain('be verbose');
  });

  it('tells the model to drop the old instructions when the system prompt is cleared mid-session', async () => {
    const { client, sessions } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['edit'] })
      .setSystemPrompt('be terse')
      .setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    wrapper.setSystemPrompt(undefined);
    await wrapper.sendAndWait('turn two');

    const resumedSendAndWait = sessions[1]?.sendAndWait as ReturnType<typeof vi.fn>;
    const secondPrompt = resumedSendAndWait.mock.calls[0]?.[0] as string;
    expect(secondPrompt).toContain('disregard the ones in the system prompt');
  });
});

describe('SessionWrapper.sendAndWait: mid-turn enablement race', () => {
  it('an in-flight call is unaffected by a disableTools that lands after its permission check already ran; a later call to the same tool is denied', async () => {
    const wrapper = new SessionWrapper(undefined, { builtins: ['edit'] });
    const config = wrapper._createConfig();

    const firstCallResult = await config.onPermissionRequest(writeRequest(), { sessionId: 's1' });
    expect(firstCallResult).toEqual({ kind: 'approve-once' });

    wrapper.disableTools('edit');

    const secondCallResult = await config.onPermissionRequest(writeRequest(), { sessionId: 's1' });
    expect(secondCallResult).toMatchObject({ kind: 'reject' });
  });
});

describe('SessionWrapper: misc lifecycle errors', () => {
  it('setModelName called after the session has started is never rejected and applies next turn', async () => {
    const { client, createCalls, resumeCalls, sessions } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['edit'] }).setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    expect(() => wrapper.setModelName('claude-opus-4.8')).not.toThrow();
    await wrapper.sendAndWait('turn two');

    expect(createCalls[0]?.model).toBe('claude-sonnet-4.5');
    expect(resumeCalls[0]?.config.model).toBeUndefined();
    expect(sessions[1]?.setModel).toHaveBeenCalledWith('claude-opus-4.8');
  });

  it('does not call setModel on resume when the model is unchanged', async () => {
    const { client, sessions } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['edit'] }).setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    await wrapper.sendAndWait('turn two');

    expect(sessions[1]?.setModel).not.toHaveBeenCalled();
  });

  it('creates one session when two first turns are sent at once', async () => {
    const { client, createCalls } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['edit'] }).setModelName('claude-sonnet-4.5');

    await Promise.all([wrapper.sendAndWait('a'), wrapper.sendAndWait('b')]);

    expect(createCalls).toHaveLength(1);
  });

  it('throws a clear error rather than calling the SDK when no client was supplied', async () => {
    const wrapper = new SessionWrapper(undefined, { builtins: ['edit'] }).setModelName('claude-sonnet-4.5');
    await expect(wrapper.sendAndWait('hello')).rejects.toThrow(/no CopilotClient/);
  });

  it('throws a clear error rather than silently dropping model when no model name was set', async () => {
    const { client } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['edit'] });
    await expect(wrapper.sendAndWait('hello')).rejects.toThrow(/no model name was set/);
  });

  it('_baseConfig fields survive the create config merge alongside a set model', async () => {
    const { client, createCalls } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['edit'] }, { workingDirectory: '/tmp/work' }).setModelName(
      'claude-sonnet-4.5'
    );

    await wrapper.sendAndWait('hello');

    expect(createCalls[0]?.workingDirectory).toBe('/tmp/work');
    expect(createCalls[0]?.model).toBe('claude-sonnet-4.5');
  });
});

describe('SessionWrapper.sendAndWait: largeOutput lockdown', () => {
  it('sends the locked-down largeOutput config on create', async () => {
    const { client, createCalls } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['edit'] }).setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');

    expect(createCalls[0]?.largeOutput).toEqual({ enabled: true, maxSizeBytes: 51200 });
  });

  it('cannot be overridden by _baseConfig, even if _baseConfig tries to disable it', async () => {
    const { client, createCalls } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['edit'] }, {
      largeOutput: { enabled: false },
    }).setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');

    expect(createCalls[0]?.largeOutput).toEqual({ enabled: true, maxSizeBytes: 51200 });
  });
});

describe('SessionWrapper side-door surface', () => {
  it('exposes no method that could bind policy/config to a session it did not create, and no post-construction tool-adding method', () => {
    const allowedPublicMethods = new Set([
      'enableTools',
      'disableTools',
      'setSystemPrompt',
      'setModelName',
      'sendAndWait',
      'session',
      'abort',
      'disconnect',
    ]);
    const excludedFromCheck = new Set(['constructor', '_createConfig', '_setEnablement']);

    const actualMethods = Object.getOwnPropertyNames(SessionWrapper.prototype).filter(
      (name) => !excludedFromCheck.has(name)
    );

    for (const name of actualMethods) {
      expect(allowedPublicMethods.has(name)).toBe(true);
    }
    expect(actualMethods.sort()).toEqual([...allowedPublicMethods].sort());
  });
});

describe('SessionWrapper never allows bash on the host (README goal 0: run_terminal_docker replaces bash)', () => {
  it('throws at construction when bash is listed as a built-in', () => {
    expect(() => new SessionWrapper(undefined, { builtins: ['view', 'bash'] })).toThrow(/'bash'.*run_terminal_docker/);
  });

  it('rejects every shell-kind permission request, even when a custom tool is named "shell"', async () => {
    const wrapper = new SessionWrapper(undefined, { builtins: ['view', 'edit', 'grep', 'glob'], custom: [fakeTool('shell')] });
    const config = wrapper._createConfig();

    await expect(config.onPermissionRequest(shellRequest(), { sessionId: 's1' })).resolves.toMatchObject({
      kind: 'reject',
    });
    await expect(config.onPermissionRequest(customToolRequest('shell'), { sessionId: 's1' })).resolves.toEqual({
      kind: 'approve-once',
    });
  });
});
