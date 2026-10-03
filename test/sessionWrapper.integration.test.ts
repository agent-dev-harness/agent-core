import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { CapiProxy } from './harness/CapiProxy';
import { CopilotClient, defineTool } from '../src/copilotSdk/boundary';
import { SessionWrapper } from '../src/copilotSdk/sessionWrapper';
import {
  FROZEN_SDK_SYSTEM_MESSAGE_BASELINE,
  stripSdkGeneratedDynamicSections,
} from './systemMessageBaseline';

describe('SessionWrapper against the live Copilot SDK', () => {
  let proxy: CapiProxy;
  let proxyUrl: string;
  let tmpWorkDir: string;
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(async () => {
    proxy = new CapiProxy();
    proxyUrl = await proxy.start();
    tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-wrapper-sdk-'));
    fs.writeFileSync(path.join(tmpWorkDir, 'notes.txt'), 'hello from the real filesystem');
  });

  afterEach(async () => {
    await proxy.stop();
    fs.rmSync(tmpWorkDir, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  function makeClient(): CopilotClient {
    return new CopilotClient({
      workingDirectory: tmpWorkDir,
      logLevel: 'none',
      useLoggedInUser: false,
      env: {
        ...process.env,
        ...proxy.getProxyEnv(),
        COPILOT_API_URL: proxyUrl,
      },
    });
  }

  function makeWrapper(client: CopilotClient, toolsConfig: ConstructorParameters<typeof SessionWrapper>[1] = {}): SessionWrapper {
    return new SessionWrapper(client, toolsConfig, {
      provider: {
        type: 'openai',
        baseUrl: proxyUrl,
        apiKey: 'test-api-key',
      },
    });
  }

  function makeEchoNotesTool() {
    let callCount = 0;
    const tool = defineTool(
      'echo_notes',
      'Echoes the contents of a text file in the working directory.',
      {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      async (args: unknown) => {
        callCount++;
        const { path: relPath } = args as { path: string };
        return fs.readFileSync(path.join(tmpWorkDir, relPath), 'utf8');
      }
    );
    return { tool, getCallCount: () => callCount };
  }

  it('creates then resumes a real SDK session across two sendAndWait calls', { timeout: 30000 }, async () => {
    const snapshotPath = path.resolve(process.cwd(), 'test/snapshots/session_wrapper/create_resume.yaml');
    await proxy.updateConfig({ filePath: snapshotPath, workDir: tmpWorkDir });

    const client = makeClient();
    await client.start();
    try {
      const wrapper = makeWrapper(client).setModelName('claude-sonnet-4.5');

      const first = await wrapper.sendAndWait('Hello', 15000);
      expect(first).toBeTruthy();

      const second = await wrapper.sendAndWait('Hello', 15000);
      expect(second).toBeTruthy();

      const completions = proxy.requestHistory.filter((r) => Array.isArray(r.messages));
      expect(completions.length).toBeGreaterThanOrEqual(2);
    } finally {
      await client.stop();
    }
  });

  it("does not drift from the installed SDK's own baseline system message", { timeout: 30000 }, async () => {
    const snapshotPath = path.resolve(process.cwd(), 'test/snapshots/session_wrapper/create_resume.yaml');
    await proxy.updateConfig({ filePath: snapshotPath, workDir: tmpWorkDir });

    const client = makeClient();
    await client.start();
    try {
      const session = await client.createSession({
        model: 'claude-sonnet-4.5',
        provider: { type: 'openai', baseUrl: proxyUrl, apiKey: 'test-api-key' },
        availableTools: [],
        autoApproveAll: false,
        onPermissionRequest: async () => ({ kind: 'reject', feedback: 'no tools' }),
      } as Parameters<typeof client.createSession>[0]);

      await session.sendAndWait('Hello', 15000);

      const completions = proxy.requestHistory.filter((r) => Array.isArray(r.messages));
      const firstSystemMessage = completions[0]?.messages.find((m: any) => m.role === 'system')?.content ?? '';

      expect(stripSdkGeneratedDynamicSections(firstSystemMessage)).toBe(FROZEN_SDK_SYSTEM_MESSAGE_BASELINE);
    } finally {
      await client.stop();
    }
  });

  it('lets a real model turn call an allowed tool, and the SDK actually executes it', { timeout: 30000 }, async () => {
    const snapshotPath = path.resolve(
      process.cwd(),
      'test/snapshots/session_wrapper/tool_permission_allowed.yaml'
    );
    await proxy.updateConfig({ filePath: snapshotPath, workDir: tmpWorkDir });

    const client = makeClient();
    await client.start();
    try {
      const wrapper = makeWrapper(client, { builtins: ['view'] }).setModelName('claude-sonnet-4.5');

      const result = await wrapper.sendAndWait('Check notes.txt', 15000);
      expect(result).toBeTruthy();

      const toolResultSent = proxy.requestHistory.some(
        (r) => Array.isArray(r.messages) && r.messages.some((m: any) => m.role === 'tool')
      );
      expect(toolResultSent).toBe(true);
    } finally {
      await client.stop();
    }
  });

  it('freezes systemMessage across resume; tool/prompt mutations surface via availableTools and an appended notice instead', { timeout: 30000 }, async () => {
    const snapshotPath = path.resolve(
      process.cwd(),
      'test/snapshots/session_wrapper/resume_rederivation.yaml'
    );
    await proxy.updateConfig({ filePath: snapshotPath, workDir: tmpWorkDir });

    const client = makeClient();
    await client.start();
    try {
      const wrapper = makeWrapper(client, { builtins: ['edit', 'view'] })
        .setModelName('claude-sonnet-4.5')
        .setSystemPrompt('Initial prompt marker.');

      await wrapper.sendAndWait('Status check', 15000);

      wrapper.disableTools('edit').enableTools('view').setSystemPrompt('Updated prompt marker.');

      await wrapper.sendAndWait('Status check', 15000);

      const completions = proxy.requestHistory.filter((r) => Array.isArray(r.messages));
      expect(completions.length).toBeGreaterThanOrEqual(2);

      const firstSystem = completions[0].messages.find((m: any) => m.role === 'system')?.content ?? '';
      const secondSystem = completions[1].messages.find((m: any) => m.role === 'system')?.content ?? '';
      const secondUser = [...completions[1].messages].reverse().find((m: any) => m.role === 'user')?.content ?? '';

      expect(firstSystem).toContain('Initial prompt marker.');
      expect(firstSystem).not.toContain('Updated prompt marker.');

      expect(secondSystem).toBe(firstSystem);

      expect(secondUser).toContain('Only the following tools are currently enabled and may be called: view.');
      expect(secondUser).toContain("additional operating instructions changed");
    } finally {
      await client.stop();
    }
  });

  it('rejects a real tool call for a tool removed before resume', { timeout: 30000 }, async () => {
    const snapshotPath = path.resolve(
      process.cwd(),
      'test/snapshots/session_wrapper/removeTools_denial.yaml'
    );
    await proxy.updateConfig({ filePath: snapshotPath, workDir: tmpWorkDir });

    const client = makeClient();
    await client.start();
    try {
      const wrapper = makeWrapper(client, { builtins: ['view'] }).setModelName('claude-sonnet-4.5');

      await wrapper.sendAndWait('Stand by', 15000);

      wrapper.disableTools('view');
      await wrapper.sendAndWait('Check notes.txt again', 15000);

      const rejectionSeen = proxy.requestHistory.some(
        (r) =>
          Array.isArray(r.messages) &&
          r.messages.some(
            (m: any) =>
              m.role === 'tool' &&
              typeof m.content === 'string' &&
              m.content.includes('is not currently enabled for this session')
          )
      );
      expect(rejectionSeen).toBe(true);

      const realFileLeaked = proxy.requestHistory.some(
        (r) =>
          Array.isArray(r.messages) &&
          r.messages.some(
            (m: any) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('hello from the real filesystem')
          )
      );
      expect(realFileLeaked).toBe(false);
    } finally {
      await client.stop();
    }
  });

  it('rejects a real "grep" tool call when "grep" is disabled, even while its permission-kind sibling "view" stays enabled', { timeout: 30000 }, async () => {
    const snapshotPath = path.resolve(
      process.cwd(),
      'test/snapshots/session_wrapper/kind_collision_denial.yaml'
    );
    await proxy.updateConfig({ filePath: snapshotPath, workDir: tmpWorkDir });

    const client = makeClient();
    await client.start();
    try {
      const wrapper = makeWrapper(client, { builtins: ['view', 'grep'] }).setModelName('claude-sonnet-4.5');
      wrapper.disableTools('grep');

      await wrapper.sendAndWait('Search for TODO in notes.txt using grep', 15000);

      const grepDenied = proxy.requestHistory.some(
        (r) =>
          Array.isArray(r.messages) &&
          r.messages.some(
            (m: any) =>
              m.role === 'tool' &&
              typeof m.content === 'string' &&
              m.content.includes('is not currently enabled for this session')
          )
      );
      expect(grepDenied).toBe(true);

      const grepRan = proxy.requestHistory.some(
        (r) =>
          Array.isArray(r.messages) &&
          r.messages.some(
            (m: any) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('hello from the real filesystem')
          )
      );
      expect(grepRan).toBe(false);
    } finally {
      await client.stop();
    }
  });

  it('lets a real model turn call a custom handler-backed tool, and the SDK actually executes it', { timeout: 30000 }, async () => {
    const snapshotPath = path.resolve(
      process.cwd(),
      'test/snapshots/session_wrapper/custom_tool_permission_allowed.yaml'
    );
    await proxy.updateConfig({ filePath: snapshotPath, workDir: tmpWorkDir });

    const client = makeClient();
    await client.start();
    try {
      const { tool: echoNotesTool, getCallCount } = makeEchoNotesTool();
      const wrapper = makeWrapper(client, { custom: [echoNotesTool] }).setModelName('claude-sonnet-4.5');

      const result = await wrapper.sendAndWait('Check notes.txt with the custom tool', 15000);
      expect(result).toBeTruthy();

      expect(getCallCount()).toBeGreaterThanOrEqual(1);

      const toolResultSent = proxy.requestHistory.some(
        (r) =>
          Array.isArray(r.messages) &&
          r.messages.some(
            (m: any) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('hello from the real filesystem')
          )
      );
      expect(toolResultSent).toBe(true);
    } finally {
      await client.stop();
    }
  });

  it('rejects a real call to a custom tool disabled before resume', { timeout: 30000 }, async () => {
    const snapshotPath = path.resolve(
      process.cwd(),
      'test/snapshots/session_wrapper/custom_tool_removeTool_denial.yaml'
    );
    await proxy.updateConfig({ filePath: snapshotPath, workDir: tmpWorkDir });

    const client = makeClient();
    await client.start();
    try {
      const { tool: echoNotesTool, getCallCount } = makeEchoNotesTool();
      const wrapper = makeWrapper(client, { custom: [echoNotesTool] }).setModelName('claude-sonnet-4.5');

      await wrapper.sendAndWait('Stand by', 15000);

      wrapper.disableTools('echo_notes');
      await wrapper.sendAndWait('Check notes.txt with the custom tool again', 15000);

      expect(getCallCount()).toBe(0);

      const rejectionSeen = proxy.requestHistory.some(
        (r) =>
          Array.isArray(r.messages) &&
          r.messages.some(
            (m: any) =>
              m.role === 'tool' &&
              typeof m.content === 'string' &&
              m.content.includes("'echo_notes' is not currently enabled for this session")
          )
      );
      expect(rejectionSeen).toBe(true);

      const realFileLeaked = proxy.requestHistory.some(
        (r) =>
          Array.isArray(r.messages) &&
          r.messages.some(
            (m: any) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('hello from the real filesystem')
          )
      );
      expect(realFileLeaked).toBe(false);

      const completions = proxy.requestHistory.filter((r) => Array.isArray(r.messages));
      expect(completions.length).toBeGreaterThanOrEqual(2);
      const firstSystem = completions[0].messages.find((m: any) => m.role === 'system')?.content ?? '';
      const secondSystem = completions[1].messages.find((m: any) => m.role === 'system')?.content ?? '';
      const secondUser = [...completions[1].messages].reverse().find((m: any) => m.role === 'user')?.content ?? '';

      expect(secondSystem).toBe(firstSystem);
      expect(secondUser).toContain('No tools are currently enabled');
    } finally {
      await client.stop();
    }
  });
});
