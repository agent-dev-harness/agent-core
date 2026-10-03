import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runForcedToolTurnUntilTimeout } from '../src/toolCallEnforcement';
import { SessionWrapper } from '../src/copilotSdk/sessionWrapper';

function makeWrapper(client: unknown, toolNames: string[] = ['my_tool']): SessionWrapper {
  return new SessionWrapper(client as any, { builtins: toolNames }, {})
    .setModelName('test-model')
    .setSystemPrompt('');
}

describe('runForcedToolTurnUntilTimeout', () => {
  it('no-tool-call -> retry once with availableTools narrowed and tool_choice set; exhausts retries -> throws', async () => {
    let callCount = 0;
    const mockSession = {
      sessionId: 'test-session',
      on: vi.fn().mockReturnValue(vi.fn()),
      sendAndWait: vi.fn().mockImplementation(async (opts) => {
        callCount++;
        if (callCount === 2) {
          expect(opts.tool_choice).toEqual({ type: 'function', function: { name: 'my_tool' } });
        }
      }),
    } as any;

    const mockClient = {
      createSession: vi.fn().mockResolvedValue(mockSession),
      resumeSession: vi.fn().mockImplementation(async (id, opts) => {
        expect(opts.availableTools).toEqual(['my_tool']);
        return mockSession;
      }),
    } as any;

    const runPromise = runForcedToolTurnUntilTimeout(makeWrapper(mockClient), 'my_tool', 'test prompt', {
      maxRetries: 1,
      getResult: () => null,
      provider: 'openrouter',
    });

    await expect(runPromise).rejects.toThrow(/Session ended without calling 'my_tool' after 1 retry/);
    expect(callCount).toBe(2);
    expect(mockClient.resumeSession).toHaveBeenCalledTimes(1);
  });

  it('resolves once the target tool fires, without any resume', async () => {
    const mockSession = {
      sessionId: 's1',
      on: vi.fn().mockImplementation((handler) => {
        handler({ type: 'tool.execution_start', data: { toolName: 'my_tool' } });
        return vi.fn();
      }),
      sendAndWait: vi.fn().mockResolvedValue(undefined),
    } as any;

    const mockClient = {
      createSession: vi.fn().mockResolvedValue(mockSession),
      resumeSession: vi.fn(),
    } as any;

    const result = await runForcedToolTurnUntilTimeout(makeWrapper(mockClient), 'my_tool', 'test prompt', {
      getResult: () => ({ ok: true }),
    });

    expect(result.toolCalled).toBe(true);
    expect(result.result).toEqual({ ok: true });
    expect(mockClient.resumeSession).not.toHaveBeenCalled();
  });

  it('passes timeoutMs straight through to sendAndWait (no watchdog ceiling applied)', async () => {
    const mockSession = {
      sessionId: 's2',
      on: vi.fn().mockImplementation((handler) => {
        handler({ type: 'tool.execution_start', data: { toolName: 'my_tool' } });
        return vi.fn();
      }),
      sendAndWait: vi.fn().mockResolvedValue(undefined),
    } as any;

    const mockClient = {
      createSession: vi.fn().mockResolvedValue(mockSession),
      resumeSession: vi.fn(),
    } as any;

    await runForcedToolTurnUntilTimeout(makeWrapper(mockClient), 'my_tool', 'test prompt', {
      timeoutMs: 42,
      getResult: () => null,
    });

    expect(mockSession.sendAndWait).toHaveBeenCalledTimes(1);
    const [promptOpts, timeout] = mockSession.sendAndWait.mock.calls[0];
    expect(promptOpts.prompt).toContain('test prompt');
    expect(timeout).toBe(42);
  });

  it('sets no turn deadline when timeoutMs is unset: passes the largest timer delay Node allows, not the SDK default', async () => {
    const mockSession = {
      sessionId: 's3',
      on: vi.fn().mockImplementation((handler) => {
        handler({ type: 'tool.execution_start', data: { toolName: 'my_tool' } });
        return vi.fn();
      }),
      sendAndWait: vi.fn().mockResolvedValue(undefined),
    } as any;

    const mockClient = {
      createSession: vi.fn().mockResolvedValue(mockSession),
      resumeSession: vi.fn(),
    } as any;

    await runForcedToolTurnUntilTimeout(makeWrapper(mockClient), 'my_tool', 'test prompt', {
      getResult: () => null,
    });

    expect(mockSession.sendAndWait).toHaveBeenCalledTimes(1);
    const [promptOpts, timeout] = mockSession.sendAndWait.mock.calls[0];
    expect(promptOpts.prompt).toContain('test prompt');
    expect(timeout).toBe(2 ** 31 - 1);
  });

  it('carries a caller-provided systemMessage through the nudge-retry resumeSession call, since resumeSession does not inherit it', async () => {
    const mockSession = {
      sessionId: 'test-session',
      on: vi.fn().mockReturnValue(vi.fn()),
      sendAndWait: vi.fn().mockImplementation(async () => {}),
    } as any;

    const mockClient = {
      createSession: vi.fn().mockResolvedValue(mockSession),
      resumeSession: vi.fn().mockImplementation(async (_id, opts) => {
        expect(opts.systemMessage).toEqual({ mode: 'customize', content: 'curated auditor prompt' });
        return mockSession;
      }),
    } as any;

    const wrapper = makeWrapper(mockClient).setSystemPrompt('curated auditor prompt');

    const runPromise = runForcedToolTurnUntilTimeout(wrapper, 'my_tool', 'test prompt', {
      maxRetries: 1,
      getResult: () => null,
    });

    await expect(runPromise).rejects.toThrow(/Session ended without calling 'my_tool'/);
    expect(mockClient.resumeSession).toHaveBeenCalledTimes(1);
  });

  it('preserves the full construction-time tool set (not narrowed to targetTools) as availableTools across a nudge-retry resume', async () => {
    const mockSession = {
      sessionId: 'test-session',
      on: vi.fn().mockReturnValue(vi.fn()),
      sendAndWait: vi.fn().mockImplementation(async () => {}),
    } as any;

    const mockClient = {
      createSession: vi.fn().mockResolvedValue(mockSession),
      resumeSession: vi.fn().mockImplementation(async (_id, opts) => {
        expect(opts.availableTools).toEqual(['my_tool', 'run_terminal_docker']);
        return mockSession;
      }),
    } as any;

    const runPromise = runForcedToolTurnUntilTimeout(
      makeWrapper(mockClient, ['my_tool', 'run_terminal_docker']),
      'my_tool',
      'test prompt',
      {
        maxRetries: 1,
        getResult: () => null,
      },
    );

    await expect(runPromise).rejects.toThrow(/Session ended without calling 'my_tool'/);
    expect(mockClient.resumeSession).toHaveBeenCalledTimes(1);
  });

  it('keeps a non-target construction-time tool (e.g. run_terminal_docker) enabled across a nudge-retry resume, not just the forced target tool', async () => {
    const mockSession = {
      sessionId: 'test-session',
      on: vi.fn().mockReturnValue(vi.fn()),
      sendAndWait: vi.fn().mockImplementation(async () => {}),
    } as any;

    let capturedOnPermissionRequest: ((req: any, invocation: any) => Promise<any>) | undefined;

    const mockClient = {
      createSession: vi.fn().mockImplementation(async (opts: any) => {
        capturedOnPermissionRequest = opts.onPermissionRequest;
        return mockSession;
      }),
      resumeSession: vi.fn().mockResolvedValue(mockSession),
    } as any;

    const wrapper = new SessionWrapper(
      mockClient,
      {
        custom: [
          { name: 'my_tool', description: '', parameters: {}, handler: async () => ({}) },
          { name: 'run_terminal_docker', description: '', parameters: {}, handler: async () => ({}) },
        ],
      },
      {},
    )
      .setModelName('test-model')
      .setSystemPrompt('');

    const runPromise = runForcedToolTurnUntilTimeout(wrapper, 'my_tool', 'test prompt', {
      maxRetries: 1,
      getResult: () => null,
    });

    await expect(runPromise).rejects.toThrow(/Session ended without calling 'my_tool'/);

    expect(capturedOnPermissionRequest).toBeDefined();
    await expect(
      capturedOnPermissionRequest!({ kind: 'custom-tool', toolName: 'run_terminal_docker' }, { sessionId: 'test-session' }),
    ).resolves.toMatchObject({ kind: 'approve-once' });
  });

  it('rejects on abort signal without touching resumeSession', async () => {
    const abortController = new AbortController();
    const mockSession = {
      sessionId: 's4',
      on: vi.fn().mockReturnValue(vi.fn()),
      sendAndWait: vi.fn().mockImplementation(() => new Promise(() => {})),
    } as any;

    const mockClient = {
      createSession: vi.fn().mockResolvedValue(mockSession),
      resumeSession: vi.fn(),
    } as any;

    const runPromise = runForcedToolTurnUntilTimeout(makeWrapper(mockClient), 'my_tool', 'test prompt', {
      abortSignal: abortController.signal,
      getResult: () => null,
    });

    abortController.abort();

    await expect(runPromise).rejects.toThrow(/aborted/);
    expect(mockClient.resumeSession).not.toHaveBeenCalled();
  });

  it('on timeout, only frees the caller: the turn is left running', async () => {
    const mockSession = {
      sessionId: 's5',
      on: vi.fn().mockReturnValue(vi.fn()),
      sendAndWait: vi.fn().mockRejectedValue(new Error('Timeout after 42ms waiting for session.idle')),
      abort: vi.fn(),
      disconnect: vi.fn(),
    } as any;

    const mockClient = {
      createSession: vi.fn().mockResolvedValue(mockSession),
      resumeSession: vi.fn(),
      stop: vi.fn(),
      forceStop: vi.fn(),
      deleteSession: vi.fn(),
    } as any;

    await expect(
      runForcedToolTurnUntilTimeout(makeWrapper(mockClient), 'my_tool', 'test prompt', {
        timeoutMs: 42,
        getResult: () => null,
      }),
    ).rejects.toThrow(/Timeout after 42ms/);

    expect(mockSession.abort).not.toHaveBeenCalled();
    expect(mockSession.disconnect).not.toHaveBeenCalled();
    expect(mockClient.stop).not.toHaveBeenCalled();
    expect(mockClient.forceStop).not.toHaveBeenCalled();
    expect(mockClient.deleteSession).not.toHaveBeenCalled();
    expect(mockClient.resumeSession).not.toHaveBeenCalled();
  });
});

describe('runForcedToolTurnUntilTimeout diagnostic logging', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  async function runTurnEmitting(events: unknown[]): Promise<void> {
    const handlers: Array<(e: unknown) => void> = [];
    const session = {
      sessionId: 's-logging',
      on: vi.fn().mockImplementation((handler) => {
        handlers.push(handler);
        return vi.fn();
      }),
      sendAndWait: vi.fn().mockImplementation(() => {
        for (const event of [...events, { type: 'tool.execution_start', data: { toolName: 'my_tool' } }]) {
          handlers.forEach((h) => h(event));
        }
        return Promise.resolve();
      }),
    } as any;
    const mockClient = { createSession: vi.fn().mockResolvedValue(session), resumeSession: vi.fn() } as any;
    await runForcedToolTurnUntilTimeout(makeWrapper(mockClient), 'my_tool', 'hi', { getResult: () => null });
  }

  it('logs each tool.execution_start event with the tool name', async () => {
    await runTurnEmitting([
      { type: 'tool.execution_start', data: { toolName: 'view' } },
      { type: 'tool.execution_start', data: { toolName: 'edit' } },
    ]);

    expect(logSpy).toHaveBeenCalledWith('[runForcedToolTurnUntilTimeout] tool used: view');
    expect(logSpy).toHaveBeenCalledWith('[runForcedToolTurnUntilTimeout] tool used: edit');
  });

  it('logs assistant.usage / session.usage_info events, capped at three', async () => {
    const usage = Array.from({ length: 5 }, (_, i) => ({ type: 'assistant.usage', data: { tokens: i } }));
    await runTurnEmitting([...usage, { type: 'session.usage_info', data: { tokens: 99 } }]);

    const usageLogCalls = logSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes('[UsageTelemetry]'));
    expect(usageLogCalls).toHaveLength(3);
  });

  it('fails loudly (console.error) instead of logging "undefined" when tool.execution_start has no toolName', async () => {
    await runTurnEmitting([
      { type: 'tool.execution_start', data: {} },
      { type: 'tool.execution_start', data: { toolName: '' } },
    ]);

    const shapeErrors = errorSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes('UNEXPECTED EVENT SHAPE'));
    expect(shapeErrors).toHaveLength(2);
    expect(String(shapeErrors[0][0])).toContain('tool.execution_start');
  });

  it('fails loudly (console.error) when a usage-telemetry event has no usable data object', async () => {
    await runTurnEmitting([{ type: 'assistant.usage', data: null }, { type: 'session.usage_info' }]);

    expect(logSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('[UsageTelemetry]'))).toBe(false);
    const shapeErrors = errorSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes('UNEXPECTED EVENT SHAPE'));
    expect(shapeErrors).toHaveLength(2);
  });
});
