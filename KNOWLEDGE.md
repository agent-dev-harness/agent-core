# agent-core — background notes

Unreviewed notes from past work. Check a claim against the code before relying on it.

## Checks

`ci/check.sh` is the merge gate and CI runs it as-is: `npm ci`, lint (`tsc`, ESLint,
`scripts/check-explicit-any.ts`, `scripts/check-boundary.ts`), build, test. Gate files
(`ci/`, `.github/`, lint/tsconfig/vitest config, the check scripts) have CODEOWNERS.
The boundary guard fails on any import from outside the package other than Node
builtins and a short third-party allowlist.

Tests run one file at a time (`vitest.config.ts`) because they share the workspace
directory and process-level state.

`npm run verify:docker` checks the Docker runner against a real, throwaway container.
The merge gate (`ci/check.sh`) runs it, so the gate needs a Docker daemon.

## Copilot SDK behaviour worth knowing

- `resumeSession()` does not carry `systemMessage` over from the session it resumes.
  Leave it out and the SDK silently falls back to its default `copilot-cli` prompt.
- `resumeSession()` also drops handler-backed custom tools unless `tools` is passed again,
  and every client-side handler (`hooks`, `onEvent`, `onUserInputRequest`, …) not passed
  again: it builds a new `CopilotSession` that registers only what the resume config has.
  `SessionWrapper` re-sends its base config on every resume for this reason, minus the
  create-only `sessionId`, `cloud` and `agent` (re-sending `agent` re-selects the start-up
  agent), and minus `model`, which a spread `ExecutionConfig` carries and which would undo
  `setModelName`.
- `CopilotClient.createSession`/`resumeSession` in `boundary.ts` default `autoApproveAll`
  to `true`, which replaces any `onPermissionRequest` you pass. `SessionWrapper` always
  passes `false`.
- `sendAndWait(prompt, timeout)` waits 60s when no timeout is given. When it times out
  the call throws but the turn keeps running. `SessionWrapper.sendAndWait` and
  `runForcedToolTurnUntilTimeout` pass `NO_TURN_DEADLINE_MS` (2^31-1 ms) instead, so a
  `run_terminal_docker` call waiting out its default 60s can't time out the turn.
- `session.send` forwards only `prompt`, `displayPrompt`, `attachments`, `mode`, `agentMode`
  and `requestHeaders` (SDK 1.0.13), so other fields such as `tool_choice` never reach the model.
- When a custom tool handler throws, the CLI replaces the message with "Tool execution failed"
  for the model and in `tool.execution_complete`'s `error.message`. A returned
  `{ resultType: 'failure', textResultForLlm, error }` keeps its text in both.
- `tool.execution_complete` carries the `toolCallId` and `success` but not the tool name; match
  it to the `tool.execution_start` with the same id.
- `view`, `grep` and `glob` share the permission kind `read`, so enabling one without the
  others can't be told apart at the permission layer.
- Changing `availableTools` or the `tools` list between turns regenerates the system
  message and busts the prompt cache, which is why `SessionWrapper` fixes both at
  construction and enables tools through permissions instead.

## Stall detection

A watchdog that treated SDK silence as a dead connection was tried and removed. Every
investigated "stall" was a slow but healthy turn (long reasoning, or many tool calls),
and the SDK gives no signal that tells the two apart. It is in git history before
`runForcedToolTurnUntilTimeout` became the only forced-turn function.

## run_terminal_docker

Arguments are parsed and clamped in `src/execTool.ts`; `workingDir` is resolved and
checked in `src/workspace/execHelpers.ts`. A missing directory exits 91. The tool matches
Copilot's bash tool: a call waits up to `initialWaitSeconds`, and a command still running then is
left running in the background under a `shellId` (`read`/`write`/`stop`/`list_terminal_docker`),
not killed. Background commands die when the session-scoped signal given to
`makeTerminalDockerHandlers` fires, and so does anything a finished command left running (the
handlers keep every run id and sweep them with `killRunsInContainer`); the per-turn `abortSignal` that `SessionWrapper` puts in each
invocation (fired by the session's `abort` event) only kills a command still inside its initial
wait. The SDK itself gives tool handlers no cancellation signal. `execCommand`, which `GitSandbox`
uses, still kills at its deadline: exit 124 with a note on stderr.

The script reaches the container on `docker exec`'s stdin, ended by a NUL. Whatever follows the
NUL is the command's stdin: nothing in sync mode, so it reads end-of-file, or what
`write_terminal_docker` sends in async mode.

The runner spawns `docker exec` detached and kills its whole process group. It also kills
inside the container, which the host can't reach through the group. It finds the run's
processes by two markers: the `EXEC_RUN_ID` environment variable and an inherited
descriptor (fd 987) on a deleted `/tmp/.exec-run-<id>` file, plus all their
descendants. Only a process that clears its environment, closes its inherited
descriptors and leaves its parent before the kill escapes.
