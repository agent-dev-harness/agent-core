import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { CapiProxy } from './harness/CapiProxy';
import { CopilotClient } from '../src/copilotSdk/boundary';
import { SessionWrapper } from '../src/copilotSdk/sessionWrapper';
import { runForcedToolTurnUntilTimeout } from '../src/toolCallEnforcement';
import { ProviderRegistry } from '../src/providerRegistry';

const SYSTEM_PROMPT = 'You are an auditor. Report findings via the tool.';
const USER_PROMPT = 'Audit this change for security issues.';

async function runSubmitFindingTurn(workDir: string, maxRetries: number): Promise<unknown> {
  const executionConfig = new ProviderRegistry('test-key').getExecutionConfig({
    provider: 'gemini',
    model: 'gemini-3.1-flash-lite',
  });
  const client = new CopilotClient({ workingDirectory: workDir, logLevel: 'none', useLoggedInUser: false });
  let result: unknown;
  await client.start();
  try {
    const submitFinding = {
      name: 'submit_finding',
      description: 'Submit an audit finding',
      parameters: {
        type: 'object',
        properties: { pass: { type: 'boolean' } },
        required: ['pass'],
      },
      handler: async (args: unknown) => {
        result = args;
        return { status: 'received' };
      },
    };
    const wrapper = new SessionWrapper(
      client,
      { builtins: ['view', 'edit', 'grep', 'glob'], custom: [submitFinding] },
      { ...(executionConfig.provider ? { provider: executionConfig.provider } : {}), streaming: false },
    )
      .setModelName(executionConfig.model)
      .setSystemPrompt(SYSTEM_PROMPT);
    const turn = await runForcedToolTurnUntilTimeout(wrapper, 'submit_finding', USER_PROMPT, {
      timeoutMs: 30000,
      maxRetries,
      getResult: () => result,
    });
    await turn.session.disconnect();
    return turn.result;
  } finally {
    await client.stop();
  }
}

describe('Forced tool turn diagnostics against real SDK/proxy transport', () => {
  let proxy: CapiProxy;
  let proxyUrl: string;
  const tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-rotation-sdk-'));

  const ORIGINAL_ENV = { ...process.env };

  beforeAll(async () => {
    proxy = new CapiProxy();
    proxyUrl = await proxy.start();
    process.env.COPILOT_API_URL = proxyUrl;
    process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';

    const snapshotPath = path.resolve(
      process.cwd(),
      'test/snapshots/forced_tool_turn/auditor_rotation_immediate_tool_call.yaml'
    );
    await proxy.updateConfig({ filePath: snapshotPath, workDir: tmpWorkDir });
  }, 30000);

  afterAll(async () => {
    await proxy.stop();
    fs.rmSync(tmpWorkDir, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  }, 30000);

  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    proxy.requestHistory.length = 0;
    logSpy = vi.spyOn(console, 'log');
    errorSpy = vi.spyOn(console, 'error');
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('logs the real tool.execution_start event emitted by the SDK when the submission tool actually runs', { timeout: 30000 }, async () => {
    await runSubmitFindingTurn(tmpWorkDir, 0);

    const toolUsedLog = logSpy.mock.calls.find((c: unknown[]) => String(c[0]).includes('tool used: submit_finding'));
    expect(toolUsedLog).toBeDefined();

    const shapeErrors = errorSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes('UNEXPECTED EVENT SHAPE'));
    expect(shapeErrors).toHaveLength(0);
  });
});
