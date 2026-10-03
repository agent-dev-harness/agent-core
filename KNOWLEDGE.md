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
  the call throws but the turn keeps running.
- `view`, `grep` and `glob` share the permission kind `read`, so enabling one without the
  others can't be told apart at the permission layer.
- Changing `availableTools` or the `tools` list between turns regenerates the system
  message and busts the prompt cache, which is why `SessionWrapper` fixes both at
  construction and enables tools through permissions instead.

## Stall watchdog

`runForcedToolTurn`, `sendAndWaitWithAbort` and the silence tracker were built to recover
from dead upstream connections. Every investigated case was a slow but healthy turn
(long reasoning, or many tool calls), and the SDK gives no signal that tells the two
apart. `runForcedToolTurnUntilTimeout` replaced it and is what callers use; the watchdog
code is unused.

## run_terminal_docker

Arguments are parsed and clamped in `src/execTool.ts`; `workingDir` is resolved and
checked in `src/workspace/execHelpers.ts`. A missing directory exits 91; a deadline kill
exits 124 with a note on stderr. Handlers pass a session-scoped abort signal that only
fires on teardown, so `parseExecToolArgs` must always return a `timeoutMs`, or a hung
command is never killed.

Both runners spawn detached and kill the whole process group. Docker mode also kills
by an `EXEC_RUN_ID` marker inside the container, which the host can't reach through
the group.
