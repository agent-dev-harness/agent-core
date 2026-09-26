# agent-core — notes for agents

Tribal knowledge for this package: non-obvious patterns and past debugging lessons.
Add here when a fix took several attempts, a bug touched files you wouldn't have
guessed, or something worked differently than expected. Keep it high-signal.

Issue and PR numbers (#NNN) refer to chrislyclau/copilot-ui, where this code was
developed before it was extracted.

## Map

- `README.md`: public API (entrypoints) and the environment variables the package reads.
- `docs/requirements.md`: EARS requirements (SYS-REQ-022 to 027).
- `docs/SessionWrapper-spec.md`: SessionWrapper tool enablement and cache stability (SYS-REQ-028).
- `docs/copilot-sdk-record-replay.md`: the CapiProxy record/replay harness the integration tests use.

## Checks

`ci/check.sh` is the merge gate, run by CI as-is: `npm ci`, lint, build, test.
`npm run lint` runs `tsc`, ESLint, `scripts/check-explicit-any.ts` and
`scripts/check-boundary.ts`; `npm test` runs vitest; `npm run build` emits `dist/`.
Gate files (`ci/`, `.github/`, lint/tsconfig/vitest config, the check scripts) have
CODEOWNERS: don't loosen them to get a change through.
The boundary guard fails if anything under `src/`, `test/` or `scripts/` imports from
outside the package (static, dynamic `import()`, `require()` or `vi.mock` paths) other
than Node builtins and its short third-party allowlist. Widening that allowlist, or the
public entrypoints, changes the package's contract with every consumer: do it only
when a consumer needs it.

## SDK imports go through src/copilotSdk/boundary.ts

`@github/copilot-sdk` is imported only in `src/copilotSdk/boundary.ts` (SYS-REQ-024),
which re-exports the types and wraps `CopilotClient`; ESLint enforces it. Sessions are
created and resumed only through `SessionWrapper` (SYS-REQ-026, issue #246), also
enforced by ESLint.

## Tests share state: keep them sequential

`vitest.config.ts` runs one file at a time in a fresh worker (`maxWorkers: 1`,
`fileParallelism: false`, `isolate: true`). Tests share the workspace directory, Docker
and process-level state; don't turn on parallelism to speed them up.

## Orphan processes on abort — resolved via detached process groups

`dockerRunner.ts` and `nativeRunner.ts` spawn with `{ detached: true }` and kill via
`killProcessGroup()` (`src/workspace/processGroup.ts`), signaling the whole process
group rather than just the direct child. Docker mode additionally runs a container-side
kill pass keyed on an `EXEC_RUN_ID` marker to catch processes the group-kill can't reach
inside the container's PID namespace. If debugging a "still running after abort"
report, check `processGroup.ts` and the container-side kill command in
`dockerRunner.ts` first — this was a known gap, but is now handled.

## Stall-watchdog recovery retired in favor of a single hard timeout

`runForcedToolTurn`'s stall watchdog (`sendAndWaitWithAbort`'s 90s-silence
threshold, `sendWithStallRetry`'s resume-then-fresh-session ladder) was built to
recover from dead upstream connections. Every investigated case (PR #136, and a
later PR-review session) turned out to be a slow-but-healthy turn -- long model
reasoning, or one chaining many tool calls -- misdiagnosed as a stall, not an
actual dead connection. Issues #188/#191 patched the watchdog to tolerate silence
during active tool *execution*, but silence during model reasoning/generation (the
observed pattern, `lastEventType=session.usage_info`) has no reliable SDK signal to
distinguish from a real stall. Recovering from a false positive also has its own
cost: `resumeSession()` re-injects the SDK's default system message and busts the
prompt cache (issue #208), making the "recovered" turn slower -- which can itself
look like a second stall.

`runForcedToolTurnUntilTimeout` (`toolCallEnforcement.ts`) is now the path all
callers use: same tool-not-called nudge/retry loop as `runForcedToolTurn`, but a
single hard timeout racing `sendAndWait` directly, with no watchdog and no
mid-turn resume. `executeAuditSession` (`auditorHelper.ts`) and all three
copilot-ui's `gateLoop.ts` forced-tool-turn call sites use it.

`runForcedToolTurn`, `sendAndWaitWithAbort`, `STALL_TIMEOUT_MS`, `isStallError`,
and their three existing test files are intentionally left in place, dormant, not
deleted -- **do not delete them as part of unrelated cleanup.** If a genuine stall
is ever observed independently of turn duration, that's the code to reach for
again. Its silence-detection logic is a standalone reusable utility -- see
"Execution-aware silence tracking" below.

## resumeSession() drops the system prompt unless you re-pass it

`client.resumeSession()` (base SDK, wrapped by `CopilotClient.resumeSession` in
`src/copilotSdk/boundary.ts`) does not inherit `systemMessage` from the session
being resumed. Any caller building a `resumeConfig` from scratch and omitting
`systemMessage` will silently fall back to the SDK's full default `copilot-cli`
system prompt (task/sub-agent, sql, report_intent, submit_code_review docs,
etc.) for the rest of the turn -- not an error, just a quietly different agent
for the remainder of the session.

This surfaced as issue #208: `executeAuditSession`'s nudge-retry resume path
(`runForcedToolTurn`'s `resumeConfig` in `toolCallEnforcement.ts`) wasn't
carrying `systemMessage` across the resume, even though the field itself
(the curated content string assembled by `buildAuditorSessionSettings` in
`auditorHelper.ts`) was correct. The fix was to also pass it on resume, not
to change the field.

This is a general SDK usage rule, not specific to PR review or to
`executeAuditSession` -- it applies to **any** future caller that resumes a
session directly. copilot-ui's `scripts/run-issue-task.ts` (see the issue #221 tracking comment near
its `PORT` constant) is one such caller: it goes through
`runForcedToolTurnUntilTimeout` directly rather than through
`executeAuditSession`, and already forwards `systemMessage` in its retry
config, so it isn't currently exposed to the #208 failure mode. It also still
lacks the rest of `executeAuditSession`'s accumulated protections (the
nudge/retry loop's other edge cases from #188/#191/#207, and any future
watchdog/mid-turn-resume work) -- re-verify it against those issues before
assuming full parity if this script's session handling changes.

## Execution-aware silence tracking

`createExecutionAwareSilenceTracker` (`toolCallEnforcement.ts`) is a standalone
utility for the "how long has the SDK gone quiet" check the (dormant) stall
watchdog above uses: it measures time since the last SDK event, but treats time
spent inside a tool call -- between `tool.execution_start` and
`tool.execution_complete`, the only events bookending it -- as *not* silence, so a
slow-but-healthy tool (`npx tsc`, a large `grep`, a slow `gh` call) isn't
misdiagnosed as a dead connection (issues #188/#191, reproduced on PR #136).

It's event-driven rather than self-subscribing to `session.on` (feed it events via
`recordEvent`), since the SDK only supports one active listener per session and
callers typically need their own listener for other event types too. It's
currently only wired up inside `sendAndWaitWithAbort`'s dormant watchdog, but was
pulled out on its own so the pattern doesn't have to be rediscovered if it's ever
needed by a new call site -- reach for it directly rather than re-deriving the
`tool.execution_start`/`tool.execution_complete` bookkeeping from scratch.


## run_terminal_docker — one shared arg/truncation boundary

`run_terminal_docker` args (`workingDir`, `timeoutSeconds`) are parsed, clamped, and
resolved in exactly two shared places: `src/execTool.ts` (parse + clamp +
output truncation) and `src/workspace/execHelpers.ts` (`resolveWorkDir` +
timeout annotation). Both exec handlers (`makeDockerToolHandler` in
copilot-ui's `src/orchestration/toolHandlers.ts`
and `makeAuditorExecToolHandler` in `auditorHelper.ts`) funnel through them. Don't
re-roll arg parsing in a new call site — the handlers previously read `workingDir`
only to log it (and the auditor one to check `..`) while silently running everything
at the workspace root, because `cd` doesn't persist across the per-call `bash -s`
process. workingDir is applied as a `cd <dir> || exit 91` guard inside the command
stream (exit 91 = "requested directory missing", traversal = rejected before any
spawn). A genuine deadline kill is annotated: exit 124 (GNU timeout convention) plus
an explicit stderr note.

`execWithDefaults` (execHelpers.ts) only enforces a deadline when `opts.timeoutMs`
is set — a caller that passes just an AbortSignal and no `opts.timeoutMs` owns the
deadline itself and gets no automatic kill. That's fine for internal callers that
invoke the runners' `execCommand` directly (e.g. gates own their timing). It is NOT
fine for the `run_terminal_docker` tool boundary: both handlers always pass a
session-scoped `abortController.signal` that only fires on session teardown, never
on a timer, so `parseExecToolArgs` must always return a populated `timeoutMs` (the
clamped model-supplied value, or `DEFAULT_TIMEOUT_SECONDS` = 60s) — never leave it
`undefined` when `timeoutSeconds` is omitted, or the tool's schema promise of a
default kill silently stops applying.
