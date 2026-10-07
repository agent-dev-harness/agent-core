import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CopilotClient, defineTool } from '../src/copilotSdk/boundary';
import { SessionWrapper } from '../src/copilotSdk/sessionWrapper';
import { ScriptedModel, lastToolResult, systemPrompt, toolCall } from './harness/ScriptedModel';

describe('ScriptedModel drives a real SDK session', () => {
  let model: ScriptedModel;
  let client: CopilotClient;
  let workDir: string;

  beforeEach(async () => {
    model = new ScriptedModel();
    await model.start();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scripted-model-'));
    client = new CopilotClient({ workingDirectory: workDir, logLevel: 'none', useLoggedInUser: false, env: model.env() });
  });

  afterEach(async () => {
    await client.stop();
    await model.stop();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('shows each step the request Copilot sent, and returns the scripted replies', { timeout: 30000 }, async () => {
    const echo = defineTool(
      'echo',
      'Echoes its input.',
      { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      async (args) => `echoed: ${(args as { text: string }).text}`,
    );
    const wrapper = new SessionWrapper(client, { custom: [echo] }, { provider: model.provider() })
      .setModelName('scripted')
      .setSystemPrompt('Answer in one word.');
    let resultSeen: string | undefined;
    model.push(
      () => toolCall('echo', { text: 'hi' }),
      (body) => {
        resultSeen = lastToolResult(body);
        return { text: 'turn one done' };
      },
      () => ({ text: 'turn two done' }),
    );

    const first = await wrapper.sendAndWait('first');
    const second = await wrapper.sendAndWait('second');
    await wrapper.disconnect();

    expect(first?.data.content).toBe('turn one done');
    expect(second?.data.content).toBe('turn two done');
    expect(resultSeen).toBe('echoed: hi');
    const [firstRequest, , resumedRequest] = model.requests.map((r) => r.body);
    expect(firstRequest?.tools?.map((t) => t.function.name)).toEqual(['echo']);
    expect(systemPrompt(firstRequest!)).toContain('Answer in one word.');
    expect(resumedRequest?.messages.at(-1)?.content).toEqual(expect.stringContaining('second'));
    expect(model.unscriptedRequests).toBe(0);
  });
});
