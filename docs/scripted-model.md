# ScriptedModel: scripted model replies for real SDK sessions

`test/harness/ScriptedModel.ts` is an in-process HTTP server that stands in for the model
behind a bring-your-own-key `openai` provider. The SDK, the CLI it starts and every part of
agent-core run for real; only the model's replies are scripted. Every request the CLI sends
is kept, so a test can check exactly what the model was shown: the system prompt, the tool
list, the prompt and each tool result.

Use it for new SDK integration tests. `CapiProxy` (`docs/copilot-sdk-record-replay.md`)
matches requests against YAML snapshots instead; ScriptedModel's script is code in the test,
and each step can look at the request it answers before choosing a reply.

## Setup

```ts
import { CopilotClient } from '../src/copilotSdk/boundary';
import { SessionWrapper } from '../src/copilotSdk/sessionWrapper';
import { ScriptedModel, lastToolResult, toolCall } from './harness/ScriptedModel';

const model = new ScriptedModel();
await model.start();
const client = new CopilotClient({ workingDirectory, logLevel: 'none', useLoggedInUser: false, env: model.env() });
const wrapper = new SessionWrapper(client, { custom: tools }, { provider: model.provider() }).setModelName('scripted');

// ...

await client.stop();
await model.stop();
```

`model.provider()` points the session at the server. `model.env()` sets `COPILOT_API_URL` to
it as well, so the CLI's own Copilot API calls stay local and no login is needed.

## Scripting replies

Each chat-completions request takes the next step. A step gets the request body and returns
`{ text }`, `{ toolCalls: [{ name, args }] }` (several calls make parallel tool calls; a
string `args` is sent as-is, for malformed arguments), optionally with `delayMs`.

```ts
model.push(
  () => toolCall('run_terminal_docker', { command: 'npm test' }),
  (body) => {
    expect(JSON.parse(lastToolResult(body)!).exitCode).toBe(0);
    return { text: 'done' };
  },
);
await wrapper.sendAndWait('Run the tests.');
```

A step runs when the CLI asks for the model's next reply, so it sees the result of the tool
call scripted before it. An assertion that fails inside a step turns into a 500 response,
so assert on values a step saved, after `sendAndWait` returns. Requests that arrive after the
script runs out get a fixed text reply and count in `model.unscriptedRequests`; check that it
is `0`.

## Reading what Copilot sent

- `model.requests`: every chat-completions request, oldest first (`url`, `headers`, `body`).
- `systemPrompt(body)`, `toolResults(body)`, `lastToolResult(body)`: the system prompt and
  the tool results the model was shown.
- `body.tools`: the tool definitions sent to the model.

Compare requests across turns to check prompt-cache stability (README goal 4): the system
prompt and `tools` should be identical on a resumed turn.
