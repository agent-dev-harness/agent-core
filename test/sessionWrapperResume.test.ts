import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CopilotClient, defineTool } from '../src/copilotSdk/boundary';
import { SessionWrapper } from '../src/copilotSdk/sessionWrapper';
import { ScriptedModel, lastToolResult, toolCall } from './harness/ScriptedModel';

describe('SessionWrapper resume against the real SDK', () => {
  let model: ScriptedModel;
  let client: CopilotClient;
  let workDir: string;

  beforeEach(async () => {
    model = new ScriptedModel();
    await model.start();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapper-resume-'));
    client = new CopilotClient({ workingDirectory: workDir, logLevel: 'none', useLoggedInUser: false, env: model.env() });
  });

  afterEach(async () => {
    await client.stop();
    await model.stop();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  const echo = defineTool('echo', 'Echoes its input.', { type: 'object', properties: { text: { type: 'string' } } }, async (args) =>
    `echoed: ${(args as { text?: string }).text}`,
  );

  it('keeps the base config hooks and onEvent on a resumed turn', { timeout: 30000 }, async () => {
    const hookedTools: string[] = [];
    const turnOfEvent: number[] = [];
    let turn = 1;
    const wrapper = new SessionWrapper(client, { custom: [echo] }, {
      provider: model.provider(),
      hooks: {
        onPreToolUse: async (input) => {
          hookedTools.push(`${turn}:${input.toolName}`);
          return JSON.stringify(input.toolArgs).includes('blocked')
            ? { permissionDecision: 'deny', permissionDecisionReason: 'blocked by the caller hook' }
            : {};
        },
      },
      onEvent: () => {
        turnOfEvent.push(turn);
      },
    }).setModelName('scripted');
    const results: (string | undefined)[] = [];
    model.push(
      () => toolCall('echo', { text: 'one' }),
      (body) => (results.push(lastToolResult(body)), { text: 'turn one done' }),
      () => toolCall('echo', { text: 'blocked' }),
      (body) => (results.push(lastToolResult(body)), { text: 'turn two done' }),
    );

    await wrapper.sendAndWait('first');
    turn = 2;
    await wrapper.sendAndWait('second');
    await wrapper.disconnect();

    expect(hookedTools).toEqual(['1:echo', '2:echo']);
    expect(results[0]).toBe('echoed: one');
    expect(results[1]).toContain('blocked by the caller hook');
    expect(turnOfEvent).toContain(2);
    expect(model.unscriptedRequests).toBe(0);
  });

  // The prompt cache only hits if a resumed turn's request extends the previous one.
  it("sends a resumed turn's request as the previous request plus new messages", { timeout: 30000 }, async () => {
    const wrapper = new SessionWrapper(client, { custom: [echo] }, {
      provider: model.provider(),
      hooks: { onPreToolUse: async () => ({}) },
    })
      .setModelName('scripted')
      .setSystemPrompt('Answer in one word.');
    model.push(
      () => toolCall('echo', { text: 'one' }),
      () => ({ text: 'turn one done' }),
      () => ({ text: 'turn two done' }),
    );

    await wrapper.sendAndWait('first');
    await wrapper.sendAndWait('second');
    await wrapper.disconnect();

    const [, lastOfTurnOne, firstOfTurnTwo] = model.requests.map((r) => r.body);
    const { messages: before, ...restBefore } = lastOfTurnOne!;
    const { messages: after, ...restAfter } = firstOfTurnTwo!;
    expect(restAfter).toEqual(restBefore);
    expect(JSON.stringify(after).startsWith(JSON.stringify(before).slice(0, -1))).toBe(true);
    expect(after.length).toBeGreaterThan(before.length);
  });

  // A spread ExecutionConfig carries `model`; setModelName must still decide each turn's model.
  it("keeps setModelName's model on every resumed turn when the base config carries a model", { timeout: 30000 }, async () => {
    const executionConfig = { model: 'model-a', providerType: 'openrouter', provider: model.provider() };
    const wrapper = new SessionWrapper(client, { custom: [echo] }, { ...executionConfig }).setModelName('model-a');
    model.push(() => ({ text: '1' }), () => ({ text: '2' }), () => ({ text: '3' }));

    await wrapper.sendAndWait('first');
    wrapper.setModelName('model-b');
    await wrapper.sendAndWait('second');
    await wrapper.sendAndWait('third');
    await wrapper.disconnect();

    expect(model.requests.map((r) => r.body.model)).toEqual(['model-a', 'model-b', 'model-b']);
  });
});
