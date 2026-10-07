import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CopilotClient, defineTool } from '../src/copilotSdk/boundary';
import { SessionWrapper } from '../src/copilotSdk/sessionWrapper';
import { runForcedToolTurnUntilTimeout } from '../src/toolCallEnforcement';
import { ScriptedModel, toolCall } from './harness/ScriptedModel';

const quietLogger = { log() {}, warn() {}, error() {} };

describe('runForcedToolTurnUntilTimeout when the target tool rejects a call', () => {
  let model: ScriptedModel;
  let client: CopilotClient;
  let workDir: string;

  beforeEach(async () => {
    model = new ScriptedModel();
    await model.start();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forced-failure-'));
    client = new CopilotClient({ workingDirectory: workDir, logLevel: 'none', useLoggedInUser: false, env: model.env() });
  });

  afterEach(async () => {
    await client.stop();
    await model.stop();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  async function runWithRejectingSubmit(reject: (message: string) => unknown) {
    let submitted: string | undefined;
    const submit = defineTool(
      'submit',
      'Submits the answer.',
      { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
      async (args) => {
        const { answer } = args as { answer: string };
        if (answer !== answer.toUpperCase()) return reject('answer must be uppercase');
        submitted = answer;
        return 'ok';
      },
    );
    const wrapper = new SessionWrapper(client, { custom: [submit] }, { provider: model.provider() }).setModelName('scripted');
    let nudge: unknown;
    model.push(
      () => toolCall('submit', { answer: 'yes' }),
      () => ({ text: 'submitted' }),
      (body) => {
        nudge = body.messages.at(-1)?.content;
        return toolCall('submit', { answer: 'YES' });
      },
      () => ({ text: 'submitted again' }),
    );
    const outcome = await runForcedToolTurnUntilTimeout(wrapper, 'submit', 'Answer yes.', { getResult: () => submitted, logger: quietLogger });
    await wrapper.disconnect();
    return { outcome, nudge: JSON.stringify(nudge) };
  }

  it("quotes a returned failure's message in the retry prompt", { timeout: 30000 }, async () => {
    const { outcome, nudge } = await runWithRejectingSubmit((message) => ({ resultType: 'failure', textResultForLlm: message, error: message }));

    expect(nudge).toContain('answer must be uppercase');
    expect(outcome.result).toBe('YES');
  });

  // The CLI replaces a thrown handler error's message, which is why the README says to return one.
  it('can only say "Tool execution failed" when the tool throws', { timeout: 30000 }, async () => {
    const { outcome, nudge } = await runWithRejectingSubmit((message) => {
      throw new Error(message);
    });

    expect(nudge).toContain('Tool execution failed');
    expect(nudge).not.toContain('answer must be uppercase');
    expect(outcome.result).toBe('YES');
  });
});
