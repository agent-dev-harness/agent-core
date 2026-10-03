# agent-core requirements (EARS)

The requirements in force for this package. Each names the code that keeps it and the
check that enforces it. The SessionWrapper tool-enablement and cache-stability
requirements (SYS-REQ-028 family) are in `docs/SessionWrapper-spec.md`.

IDs keep the numbers they were first written under, so references in code and comments
stay valid. Gaps in the numbering are IDs that no longer apply; see "Retired IDs" at the
end.

## How the README goals are covered

| README goal | Requirements | Enforced by |
|---|---|---|
| 0. `run_terminal_docker` completely replaces the bash tool | — | `src/copilotSdk/sessionWrapper.test.ts`, "SessionWrapper never allows bash on the host" |
| 1. One way in for anything risky | SYS-REQ-023, 024, 026, 026c, 027e | `eslint.config.js` (`npm run lint`) |
| 2. No hangs: every `run_terminal_docker` command has a deadline | — | `test/workspace/execToolArgs.test.ts` (default timeout, clamping); `test/workspace/execToolWorkingDir.test.ts` ("execCommand timeout handling", "makeAuditorExecToolHandler deadline enforcement") |
| 3. Agents stay in the workspace | SYS-REQ-022, 023 | `test/workspace/execToolArgs.test.ts` ("resolveWorkDir"); `test/workspace/execToolWorkingDir.test.ts` ("rejects traversal without spawning anything") |
| 4. A stable prompt cache | SYS-REQ-026a, 026b, 027b; SYS-REQ-028 family | `src/copilotSdk/sessionWrapper.test.ts` |

## Workspace paths

All workspace management is handled via the src/workspace code, to which changes are not permitted without a discussion.

- **SYS-REQ-022 (Path Space Separation):** The system distinguishes three path spaces
  that must never be substituted for one another:
  1. **Caller's source tree** (`process.cwd()`): the calling application's own files,
     never a workspace.
  2. **Host-side managed workspace** (`getWorkspaceHostLocation()`): the managed
     workspace as the Node process sees it, for direct fs calls and mounting.
  3. **Execution-side managed workspace** (`getWorkspaceRoot()`): the managed workspace
     as seen wherever `getExecCommand()` runs. In Docker mode this is the container
     path; in native mode it is the same as the host path.
- **SYS-REQ-023:** Any `cwd` passed to `getExecCommand()` **shall** be sourced from
  `getWorkspaceRoot()`, never `getWorkspaceHostLocation()` or `process.cwd()`.
  `getWorkspaceHostLocation()` is reserved for callers that work directly against the
  Node process's own filesystem view (for example, `CopilotClient`'s
  `workingDirectory`). A tool-supplied working directory **shall** be resolved with
  `resolveWorkDir()` against `getWorkspaceRoot()`, which rejects any path outside it.

## SDK import boundary

- **SYS-REQ-024:** All `@github/copilot-sdk` imports **shall** be confined to
  `src/copilotSdk/boundary.ts`. No other module may import from `@github/copilot-sdk`
  directly; they consume re-exported types and wrapper functions from the boundary
  module instead. Enforced by `no-restricted-imports` in `eslint.config.js`.

## SessionWrapper (sole SDK session entry point)

Session creation and resumption are a common source of silent regressions: a dropped
`systemMessage`, dropped tool scoping, or config drift on resume that busts the prompt
cache. Rather than spec each pitfall individually, the system closes them structurally
with a single choke-point class, `SessionWrapper` (`src/copilotSdk/sessionWrapper.ts`).

- **SYS-REQ-026:** All `CopilotClient.createSession` and `CopilotClient.resumeSession`
  calls **shall** be issued exclusively through `src/copilotSdk/sessionWrapper.ts`. No
  other module, including scripts under `scripts/`, may call these SDK methods
  directly.
- **SYS-REQ-026a:** Each session's tool policy (the construction-time list of built-in
  and custom tools, and the `systemMessage` frozen at creation) **shall** be stored as
  an immutable value bound to the session at creation time.
- **SYS-REQ-026b:** On every resume, for any reason (retry, reconnect, or otherwise),
  `SessionWrapper` **shall** re-derive the session configuration from the stored
  policy, never from a partial or caller-supplied config, so a resumed session cannot
  silently diverge from its original tool scoping or system prompt. SYS-REQ-028g says
  which fields are resent.
- **SYS-REQ-026c (Unwanted Behavior):** **If** any module attempts to call
  `createSession`/`resumeSession` outside `SessionWrapper`, **then** this **shall** be
  caught by a lint rule covering both `src/**` and `scripts/**`, not left to code
  review alone.
- **SYS-REQ-027 (Ubiquitous):** All Copilot session state (tool list, system prompt,
  model name) **shall** be held as private fields on a `SessionWrapper` instance. No
  other module **shall** read or write this state directly.
- **SYS-REQ-027b:** `_createConfig()` **shall** be the only function that turns the
  stored tool list, system prompt and model name into the SDK-bound config (the
  `systemMessage`, the SDK tool list with handlers, and `availableTools`). It **shall**
  remain a single function, not split into sub-steps, because correct construction
  depends on SDK-specific ordering and interaction behaviour (for example,
  `systemMessage` mode selection) that a split risks silently violating.
- **SYS-REQ-027c:** `sendAndWait()` **shall** decide internally whether to call
  `createSession` or `resumeSession` against the SDK boundary
  (`src/copilotSdk/boundary.ts`, SYS-REQ-024). This decision **shall** be invisible to
  the caller: the caller-visible contract (response shape, tool enforcement,
  system-prompt effect) is the same whether the underlying call is a fresh session or a
  resume.
- **SYS-REQ-027e (Unwanted Behavior):** **If** any module calls
  `CopilotClient.createSession` or `CopilotClient.resumeSession` directly instead of
  through `SessionWrapper`, **then** this **shall** be caught by an ESLint rule covering
  `src/**` and `scripts/**` (the same pattern as SYS-REQ-024/026c in
  `eslint.config.js`), not left to code review alone.
- **SYS-REQ-027f (Unwanted Behavior):** **If** a mutator (`enableTools`,
  `disableTools`, `setSystemPrompt`, `setModelName`) is called after a session has
  started, **then** the wrapper's behaviour **shall** be explicitly defined, not left
  dependent on internal timing. The current definitions: `enableTools`/`disableTools`
  apply from the next permission check (SYS-REQ-028k); `setSystemPrompt` never changes
  the frozen `systemMessage` and is relayed only as a notice on the next turn
  (SYS-REQ-028h, 028l); `setModelName` is accepted and has no effect, since `model` is
  not resent on resume (SYS-REQ-028g).
- **SYS-REQ-027g (Unwanted Behavior):** **If** any external module attempts to bind
  tool policy or config to a session `SessionWrapper` did not itself create, **then**
  this **shall not** be supported. Sessions created outside `SessionWrapper` are out of
  its scope entirely rather than adoptable after the fact, so the point of entry stays
  singular. Open question: `SessionWrapper.adopt()` wraps a session the new wrapper did
  not create, which conflicts with this requirement and SYS-REQ-028f. It is tracked as
  `TODO(#78)` in `sessionWrapper.ts` and waits on the owner's decision.

Tests for this section are in `src/copilotSdk/sessionWrapper.test.ts`: "SessionWrapper._createConfig"
(027b), "construction/resume lifecycle" (026b, 027c), "systemMessage" and "per-turn
enablement notice" (027f), "misc lifecycle errors" (027f, `setModelName`) and
"side-door surface" (027g).

## Retired IDs

These IDs no longer apply. They are listed so that a reference to one can be traced.

- **SYS-REQ-023 (part):** also named `runTests`, `runLint` and `runWithTimeout`, which
  don't exist in this package.
- **SYS-REQ-025:** never part of this package.
- **SYS-REQ-027a, 027a-1, 027d, 027h, 027i, 027j, 027k:** replaced by the SYS-REQ-028
  family in `docs/SessionWrapper-spec.md`.
