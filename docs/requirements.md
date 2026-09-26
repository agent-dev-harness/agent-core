# agent-core requirements (EARS)

Requirements the package itself must satisfy, moved from copilot-ui's
`docs/system-requirements.md` when agentCore was extracted (numbering kept so
existing references stay valid). The SessionWrapper tool-enablement and cache
stability requirements (SYS-REQ-028 family) are in `docs/SessionWrapper-spec.md`.

### 5.2 Host-Container Volume Handoff & Git Guard Rail

All workspace management is handled via the src/workspace code, to which changes are not permitted without a discussion.

- **SYS-REQ-022 (Path Space Separation):** The system distinguishes three path spaces that must never be substituted for one another:
  1. **App source tree** (`process.cwd()` at server boot) — the copilot-ui repo itself.
  2. **Host-side managed workspace** (`getWorkspaceHostLocation()`) — the managed workspace as visible to the Node process itself (e.g. for direct fs calls, mounting).
  3. **Execution-side managed workspace** (`getWorkspaceRoot()`) — the managed workspace as visible _inside_ wherever `getExecCommand()` actually runs (container path in Docker mode; identical to host path in native mode).
- **SYS-REQ-023:** Any `cwd` passed to `getExecCommand()`, `runTests`, `runLint`, or `runWithTimeout` **shall** be sourced from `getWorkspaceRoot()`, never `getWorkspaceHostLocation()` or `process.cwd()`. `getWorkspaceHostLocation()` is reserved for callers that operate directly against the Node process's own filesystem view (e.g. `CopilotClient`'s `workingDirectory`).

### 5.3 SDK Import Boundary

- **SYS-REQ-024:** All `@github/copilot-sdk` imports **shall** be confined to `src/copilotSdk/boundary.ts`. No other module may import from `@github/copilot-sdk` directly; they consume re-exported types and wrapper functions from the boundary module instead.

### 5.5 SessionWrapper (Sole SDK Session Entry Point)

Session creation and resumption are a common source of silent regressions (dropped `systemMessage`, dropped tool-scoping, cache-busting config drift on resume). Rather than spec each pitfall individually, the system closes them structurally with a single choke-point module.

> **Superseded `hardenedSession.ts`.** Per the "Migration plan (hotswap)" section below, `SessionWrapper` (`src/copilotSdk/sessionWrapper.ts`) replaced `hardenedSession.ts` as the sanctioned entry point once the one-pass call-site migration (step 4) and file deletion (step 5) landed. The detailed SessionWrapper requirements live under SYS-REQ-027 (and SYS-REQ-028 where noted); SYS-REQ-026/026a-c below are retained as the base system-level statement of the choke-point requirement, now pointed at the current module.

- **SYS-REQ-026:** All `CopilotClient.createSession` and `CopilotClient.resumeSession` calls **shall** be issued exclusively through `src/copilotSdk/sessionWrapper.ts`. No other module — including scripts under `scripts/` — may call these SDK methods directly.
- **SYS-REQ-026a:** Each session's tool policy (`availableTools`, `tools`, `systemMessage`, `autoApprovedTools`) **shall** be stored as an immutable value bound to the session at creation time.
- **SYS-REQ-026b:** On every resume, for any reason (retry, reconnect, or otherwise), `SessionWrapper` **shall** re-derive the full session configuration from the stored policy — never a partial or caller-supplied config — so a resumed session cannot silently diverge from its original tool-scoping or system prompt.
- **SYS-REQ-026c (Unwanted Behavior):** **If** any module attempts to call `createSession`/`resumeSession` outside `SessionWrapper`, **then** this **shall** be caught by lint rule (covering both `src/**` and `scripts/**`), not left to code review alone.
- _Rationale:_ This supersedes ad hoc handling of resume-time hazards (e.g. dropped `systemMessage`, dropped `onPermissionRequest`) by making them structurally unreachable rather than individually documented and re-discovered per call site.


# SessionWrapper — Spec Draft (EARS)

> **Superseded in part by SYS-REQ-028** (see `docs/SessionWrapper-spec.md`,
> "SessionWrapper: Tool Enablement & Cache Stability"). That spec replaces
> the tool-mutation and system-message requirements formerly numbered
> SYS-REQ-027a, 027a-1, 027d, 027h, 027i, 027j, and 027k — removed from this
> section as of the SYS-REQ-028 cutover; see `docs/SessionWrapper-spec.md`
> for their current form — with a fixed construction-time tool schema
> (`enableTools`/`disableTools` over a set declared at construction, not
> `addTools`/`removeTools`/`addTool`/`removeTool`) and a three-state
> permission model (declared-but-disabled vs. declared-and-enabled vs.
> never-declared) in place of the old present-in-`_tools` pure-membership
> model. The old 027f's underlying concern (post-start mutator calls need
> explicitly-defined behavior) still applies but now names
> `enableTools`/`disableTools`, not `addTools`/`removeTools`; see
> SYS-REQ-028b in `docs/SessionWrapper-spec.md`. The rest of this section
> (027, 027b, 027c, 027e, 027g) is still current. The "Migration plan" and
> "Test coverage implied by this spec" subsections below reference the
> pre-028 mutator names and predate the rename.

**Status:** draft, replaces SYS-REQ-026 family (decision made — see below)
**Relationship to existing spec:** §5.5 above ("SessionWrapper
(Sole SDK Session Entry Point)", moved here from README.md's §5.5 as of the
doc split) contains SYS-REQ-026/026a/026b/026c, now
pointed at `src/copilotSdk/sessionWrapper.ts` as the sanctioned entry point.
At the time this section was drafted, that entry point was still
`src/copilotSdk/hardenedSession.ts` (the `src/` tree has since been
reorganized under `src/`; this path reflects the layout at
draft time, not the current one) — a function module keyed by
`sessionId` against two separate `Map`s — `policyBySessionId` and `sessionBySessionId`
— correlated only by matching keys. `SessionWrapper` **replaced** that module outright,
rather than wrapping it — see the "Migration plan (hotswap)" section for how the
cutover happened. Reasons `SessionWrapper` replaced rather than wrapped
`hardenedSession.ts`, found on inspection of the pre-migration code:

- The policy/session map pair is itself a two-things-must-stay-in-sync problem
  (same class of bug SYS-REQ-026b was written to prevent, one level up) — an
  instance owning both pieces of state removes it structurally.
- `registerSessionPolicy` is a documented side door letting a policy be attached
  to a session `hardenedSession.ts` never created — the enforcement point isn't
  actually singular today. `SessionWrapper` should not carry this forward (see
  SYS-REQ-027g below).
- Resume can hand back a different `sessionId`, requiring re-keying across three
  maps (`policyBySessionId`, `sessionBySessionId`, `rejectedAttemptsBySessionId`).
  An instance has no external key to fall out of sync with.
- Callers of `createHardenedSession`/`resumeHardenedSession` still get the raw
  `CopilotSession` back and drive it themselves — the hardening only covers
  creation/resume, not the full lifecycle. `SessionWrapper.sendAndWait()` owns
  the whole lifecycle, a strictly larger guarantee.

**Migration strategy — hotswap, not in-place edit:** `SessionWrapper` is built in a
new file, developed and tested against this spec in full isolation, with zero call
sites depending on it. `hardenedSession.ts` keeps running unmodified until
`SessionWrapper` is complete and every requirement below is verified. Only then are
call sites (`toolCallEnforcement.ts` and others) migrated in one pass, and
`hardenedSession.ts` deleted. No intermediate state where both are partially wired
into production call sites — avoids exactly the kind of half-migrated, dual-mechanism
drift this spec exists to close off. See "Migration plan" section at the end.

---

## Requirements

- **SYS-REQ-027 (Ubiquitous):** All Copilot session state (tool list, system prompt,
  model name) **shall** be held as private fields on a `SessionWrapper` instance. No
  other module **shall** read or write this state directly.

- **SYS-REQ-027b:** `_createConfig()` **shall** be the only function that reads
  `_tools`, `_systemPrompt`, and `_modelName` to produce the SDK-bound config
  (including the system-prompt tool-usage section and the SDK tool list with
  handlers). It **shall** remain a single function — not split into sub-steps —
  because correct construction depends on SDK-specific ordering/interaction
  behavior (e.g. `systemMessage` mode selection, cf. issue #146) that a split
  risks silently violating.

- **SYS-REQ-027c:** `sendAndWait()` **shall** call `_createConfig()` on session
  start and **shall** decide internally whether to call `createSession` or
  `resumeSession` against the SDK boundary (`src/copilotSdk/boundary.ts`,
  SYS-REQ-024). This decision **shall** be invisible to the caller: identical
  caller-visible contract (response shape, tool enforcement, system-prompt effect)
  whether the underlying call is a fresh session or a resume.

- **SYS-REQ-027e (Unwanted Behavior):** **If** any module calls
  `CopilotClient.createSession` or `CopilotClient.resumeSession` directly instead
  of through `SessionWrapper`, **then** this **shall** be caught by an eslint rule
  covering `src/**` and `scripts/**` (mirroring the existing pattern for
  SYS-REQ-024/026c in `eslint.config.js`), not left to code review alone.

- **SYS-REQ-027f (Unwanted Behavior):** **If** `addTools`/`removeTools`/`setSystemPrompt`/other
  mutators are called after a session has started, **then** the wrapper's behavior
  **shall** be explicitly defined (either: rejected with a thrown error, or:
  applied and used starting next turn via re-derivation per SYS-REQ-027d) — not
  left as undefined behavior dependent on internal timing.

- **SYS-REQ-027g (Unwanted Behavior):** **If** any external module attempts to
  bind tool policy / config to a session `SessionWrapper` did not itself create
  (the `hardenedSession.ts` `registerSessionPolicy` side door), **then** this
  **shall not** be supported. Sessions created outside `SessionWrapper` are out
  of scope for it entirely, rather than adoptable after the fact — the enforced
  point of entry stays singular. Any pre-existing call site relying on
  `registerSessionPolicy` (e.g. `toolCallEnforcement.ts`) **shall** be migrated
  to construct/own a `SessionWrapper` from the start, not grandfathered in.

---

## Test coverage implied by this spec

1. **Invariant tests (027b, 027h):** for varying tool lists (0, 1, N tools), the
   system-prompt tool section, SDK tool config, and permission outcome for every
   candidate tool (in-list → approved, not-in-list → denied) never disagree —
   assert on `_createConfig()`'s output as a black box.
2. **SDK-footgun regression tests (027b, 027d, 027k):** one per documented landmine
   (issue #208 resume dropping `systemMessage`, issue #146 customize-mode cache
   invalidation, issue #345 systemMessage regeneration on resume busting the
   prompt/KV cache prefix, any others surfaced in comments) — these exist
   specifically because `_createConfig()` is intentionally opaque, so the
   tests are the only enforcement that those constraints keep holding.
3. **Contract tests on `sendAndWait` (027c):** call it fresh, call it again on
   the same instance, assert no caller-visible difference except where the SDK
   genuinely requires different plumbing internally.
4. **Mutator-after-start tests (027f):** whatever the chosen behavior is
   (reject vs. apply-next-turn), assert it explicitly rather than leaving it
   implicit.
5. **Resume-notice tests (027k):** for a tool-list or system-prompt change
   between turns, the resumed `systemMessage` **shall** stay byte-identical
   to the create call's while the change instead appears as a notice
   prepended to the resumed turn's prompt; for no change between turns, no
   notice **shall** be appended at all.

## Migration plan (hotswap)

1. **Build in isolation.** New file (e.g. `src/copilotSdk/sessionWrapper.ts` —
   this cutover predates the later `src/` reorg; the file now lives
   at `src/copilotSdk/sessionWrapper.ts`),
   zero imports from or into `hardenedSession.ts`, zero production call sites
   wired to it yet.
2. **Satisfy every SYS-REQ-027* item and its associated tests** (invariant,
   SDK-footgun regression, `sendAndWait` contract, mutator-after-start) against
   the new file alone.
3. **Resolve open items explicitly before step 2 is called done:**
   permission-policy ownership (027h), and confirm no code path reintroduces a
   `registerSessionPolicy`-style side door (027g).
4. **One-pass call-site migration (done).** Identify every caller of
   `createHardenedSession`/`resumeHardenedSession`/`registerSessionPolicy`
   (`toolCallEnforcement.ts` and any others), switch each to construct/own a
   `SessionWrapper` instance, in a single change — not incremental per-caller
   swaps that leave both mechanisms live in production simultaneously.
5. **Delete `hardenedSession.ts` (done).** Its direct tests
   (`hardenedSession.test.ts`, `hardenedSession.typecheck.test.ts`) are removed
   along with it; issue #277 permission-kind regression coverage was ported to
   `sessionWrapper.test.ts`.
6. **Update the eslint rule (SYS-REQ-027e) (done).** References
   `SessionWrapper` instead of `createHardenedSession`/`resumeHardenedSession`
   as the sanctioned entry point.

No intermediate commit should have both `SessionWrapper` and `hardenedSession.ts`
wired into live call sites at once. SYS-REQ-026 (section 5.5) reflects this
completed end state.
