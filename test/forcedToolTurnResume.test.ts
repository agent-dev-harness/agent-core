import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

describe('forced tool turn retry against real SDK/proxy transport', () => {
  let proxy: CapiProxy;
  let proxyUrl: string;
  const tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-resume-'));

  beforeAll(async () => {
    proxy = new CapiProxy();
    proxyUrl = await proxy.start();
    process.env.COPILOT_API_URL = proxyUrl;
    process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';

    const snapshotPath = path.resolve(
      process.cwd(),
      'test/snapshots/forced_tool_turn/audit_retry_prompt_prefix.yaml'
    );
    await proxy.updateConfig({ filePath: snapshotPath, workDir: tmpWorkDir });
  }, 30000);

  afterAll(async () => {
    await proxy.stop();
    fs.rmSync(tmpWorkDir, { recursive: true, force: true });
  }, 30000);

  it('does not mutate the original prompt prefix when resumeSession retries', { timeout: 30000 }, async () => {
    const result = await runSubmitFindingTurn(tmpWorkDir, 1);

    expect(result).toBeTruthy();

    const completions = proxy.requestHistory.filter((r) => Array.isArray(r.messages));
    expect(completions.length).toBeGreaterThanOrEqual(2);

    const firstRequest = completions[0];
    const secondRequest = completions[1];

    const firstUserMessage = firstRequest.messages.find((m: any) => m.role === 'user');
    expect(firstUserMessage.content).toContain(USER_PROMPT);

    const secondUserMessage = secondRequest.messages[1];
    expect(secondUserMessage.role).toBe('user');
    expect(secondUserMessage.content).toBe(firstUserMessage.content);

    const nudgeMessage = secondRequest.messages[3];
    expect(nudgeMessage.role).toBe('user');
    expect(nudgeMessage.content).not.toBe(firstUserMessage.content);
    expect(nudgeMessage.content).not.toContain(USER_PROMPT);
  });
});
