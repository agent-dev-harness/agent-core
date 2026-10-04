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

## Copilot SDK behaviour worth knowing

- `resumeSession()` does not carry `systemMessage` over from the session it resumes.
  Leave it out and the SDK silently falls back to its default `copilot-cli` prompt.
- `resumeSession()` also drops handler-backed custom tools unless `tools` is passed again.
- `CopilotClient.createSession`/`resumeSession` in `boundary.ts` default `autoApproveAll`
  to `true`, which replaces any `onPermissionRequest` you pass. `SessionWrapper` always
  passes `false`.
- `sendAndWait(prompt, timeout)` waits 60s when no timeout is given. When it times out
  the call throws but the turn keeps running. `SessionWrapper.sendAndWait` and
  `runForcedToolTurnUntilTimeout` pass `NO_TURN_DEADLINE_MS` (2^31-1 ms) instead, so a
  default 60s `run_terminal_docker` deadline can't time out the turn.
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
checked in `src/workspace/execHelpers.ts`. A missing directory exits 91; a deadline kill
exits 124 with a note on stderr. Handlers pass a session-scoped abort signal that only
fires on teardown, so `parseExecToolArgs` must always return a `timeoutMs`, or a hung
command is never killed. `SessionWrapper` also gives each custom tool call a per-turn
`abortSignal` in its invocation, fired by the session's `abort` event, and the handler
kills the command when either signal fires. The SDK itself gives tool handlers no
cancellation signal.

Both runners spawn detached and kill the whole process group. Docker mode also kills
inside the container, which the host can't reach through the group. It finds the run's
processes by two markers: the `EXEC_RUN_ID` environment variable and an inherited
descriptor (fd 987) on a deleted `/tmp/.exec-run-<id>` file, plus all their
descendants. Only a process that clears its environment, closes its inherited
descriptors and leaves its parent before the kill escapes.
