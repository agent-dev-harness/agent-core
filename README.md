# @agent-dev-harness/agent-core

agent-core is a private TypeScript library that runs AI agent sessions on the GitHub
Copilot SDK. It has four parts:

| Part | What it does |
|---|---|
| **Sessions** | `SessionWrapper` is the only way to create or resume a session. The tool list is fixed when the session is created, and tools are switched on and off through permissions. That keeps the prompt cache valid across resumes. The SDK is only imported in `boundary.ts`. |
| **Forced tool turns** | `runForcedToolTurnUntilTimeout` makes the model answer by calling a named tool. It nudges and retries if the model doesn't, or if its call fails. A timeout only frees the caller: the turn keeps running. |
| **Workspace** | The Docker runner, the `run_terminal_docker` tool and its `read`/`write`/`stop`/`list_terminal_docker` companions (working directory, background commands, output truncation), killing the whole process group on abort, and `GitSandbox`. |
| **Providers** | `ProviderRegistry` plus an HTTP proxy. Bring-your-own-key models go through OpenRouter; a model configured as `copilot-native` uses Copilot's own models with no provider config. A model the registry has no config for routes to OpenRouter, and with no model and no `tierModels` it throws. |

## Goals

0. **Most important requirement:** `run_terminal_docker` completely replaces the bash tool.
1. **One way in for anything risky:** SDK imports, session creation and workspace paths each
   have one allowed route, and lint checks enforce it.
2. **No hangs:** every `run_terminal_docker` call returns by its initial wait. As with Copilot's
   bash tool, a command still running then keeps running in the background until it exits, is
   stopped, or the session ends. Ending the session also kills whatever a finished command left
   running, such as a server started with `&`.
3. **Agents stay in the workspace:** commands run in the sandbox, and paths can't reach
   outside it.
4. **A stable prompt cache:** a resumed session sends the same tools and system prompt as
   before.

Out of scope: model and role configuration. The caller passes these in.

`KNOWLEDGE.md` holds unreviewed background notes.

## Requirements

- Node.js 22.12 or later. The package is ESM; CommonJS consumers load it with `require()`.
- The GitHub Copilot CLI (`@github/copilot`), which `@github/copilot-sdk` launches to run
  sessions.
- A running container reachable as `CONTAINER_NAME` with the workspace
  bind-mounted at the same absolute path as on the host (see `WORKSPACE_HOST_LOCATION`).
  Start it with `docker run --init` (or another init as PID 1): killed commands are reparented
  to PID 1, and without an init that reaps them they stay in `ps` as `<defunct>`.

## Installing

The package isn't published to a registry. Install it from GitHub, pinned to a release tag
or a commit:

```bash
npm install github:agent-dev-harness/agent-core#v0.5.0
```

npm builds `dist/` during the install (the `prepare` script), which takes about 40 seconds.
No SSH key or token is needed. To upgrade, change the tag. `@github/copilot-sdk` is pinned
to an exact version, so consumers get the SDK this repo's tests ran against.

To release, bump `version` in `package.json` in a PR. When it merges, CI runs the merge
gate on `main` and tags that commit `v<version>`.

## Entrypoints

| Import | Contents |
|---|---|
| `@agent-dev-harness/agent-core` | `SessionWrapper`, `TurnToolInvocation`, `CopilotClient`, `defineTool` and the re-exported SDK types; `runForcedToolTurnUntilTimeout`; context helpers (`SlidingWindowCircularBuffer`, `enforceWorkingMemoryTruncation`, `cleanSubprocessLogs`, `clearCleanCache`); exec-tool helpers (`makeTerminalDockerHandlers`, the deprecated `makeRunTerminalDockerHandler`, `parseExecToolArgs`, `truncateExecResult`); `ProviderRegistry` and its config types, `OPENROUTER_SESSION_ID_HEADER`; `PROVIDERS`, `isProviderType`, `ModelProviderConfig`; the tool definitions `TERMINAL_DOCKER_TOOLS` (`RUN_`, `READ_`, `WRITE_`, `STOP_` and `LIST_TERMINAL_DOCKER_TOOL`) |
| `@agent-dev-harness/agent-core/workspace` | `initializeWorkspace`, `getExecCommand`, `getGitSandbox`, `getWorkspaceRoot`, `getWorkspaceHostLocation`, `resolveWorkDir`, `TRAVERSAL_ERROR`, `GitSandbox`, `killProcessGroup` |
| `@agent-dev-harness/agent-core/proxy` | `mountProviderProxyRoute`, `OPENROUTER_SESSION_ID_HEADER` (needs `express`, an optional peer dependency) |
| `@agent-dev-harness/agent-core/types` | Type-only exports, safe to import from browser code |

Call `initializeWorkspace()` once at startup before using the workspace functions or
`makeTerminalDockerHandlers`. If it fails (for example, the container isn't up yet), call it again.
Commands always run in the Docker container. To subclass `GitSandbox` (for example, to add branch-per-task
operations), pass `initializeWorkspace({ createSandbox })`.

Use `wrapper.abort()` to stop the current turn and `wrapper.disconnect()` to end the
session; the next `sendAndWait` after `disconnect()` starts a fresh session. A turn still
running when you call `disconnect()` is aborted and its `sendAndWait` rejects, as do turns
waiting behind it. Turns on one wrapper run one at a time: a `sendAndWait` made while another is
running waits for it, then runs its own turn and returns its own reply. The `.session`
getter, which hands out the raw SDK session, is deprecated and will be removed.

`run_terminal_docker` behaves like Copilot's bash tool. It waits up to `initialWaitSeconds`
(default 60) for the command. A command still running then is not killed: the call returns the
output so far with `status: "running"` and a `shellId`, and the command keeps running.
`read_terminal_docker` returns the output since the last read and, once the command is done, its
exit code. `write_terminal_docker` sends input to a command started with `mode: "async"`,
`stop_terminal_docker` kills one, and `list_terminal_docker` lists them. Register all five, with
one `makeTerminalDockerHandlers(sessionSignal)` per session: the handlers share that session's
commands, and when `sessionSignal` fires (or you call `stopAll()`) every command still running
is killed, along with any process a finished command left running. `disconnect()` doesn't fire
`sessionSignal`; abort it yourself when the session ends.

```ts
const terminal = makeTerminalDockerHandlers(sessionAbort.signal);
const tools = TERMINAL_DOCKER_TOOLS.map(({ function: f }) =>
  defineTool(f.name, f.description, f.parameters, (args, invocation) => terminal[f.name](args, invocation)),
);
```

`SessionWrapper` passes each custom tool handler a `TurnToolInvocation`, whose `abortSignal`
fires when the turn is aborted (`wrapper.abort()`). `run_terminal_docker` kills a command that is
still inside its initial wait when that signal fires; one already in the background keeps
running, which is why the example passes `invocation` through.

A tool result larger than 50 KB (51,200 bytes of the result as the SDK serializes it) is
saved to a file, and the model gets a short preview and the file's path instead. That can
happen to `run_terminal_docker` output under its 40k-character cap: escape codes and non-ASCII
text grow when serialized. The file goes to the OS temp directory, which the container can't
see, so put it in the workspace with `largeOutput.outputDirectory`. Because the workspace has
the same path on the host and in the container, the agent can then read the path with
`run_terminal_docker` or with `view`/`grep`. `snapshots/` stays out of diffs and checkpoints,
and the CLI deletes the files when the session disconnects. `SessionWrapper` takes only
`outputDirectory` from `largeOutput`; the size limit and `enabled` are fixed.

```ts
import { getWorkspaceRoot } from "@agent-dev-harness/agent-core/workspace";

const wrapper = new SessionWrapper(client, { custom: tools }, {
  largeOutput: { outputDirectory: `${getWorkspaceRoot()}/snapshots/tool-output` },
});
```

To group a session's OpenRouter requests, pass
`registry.getExecutionConfig(model, { openRouterSessionId })`. The provider config then
carries the id in a request header, and the proxy adds it to each request body as
`session_id`, so concurrent sessions in one process each keep their own id.

## Environment variables

The package reads these at runtime. Everything else, including model and role
configuration, is passed in by the caller.

| Variable | Read by | Effect |
|---|---|---|
| `CONTAINER_NAME` | Docker runner | Name of the container commands run in. |
| `WORKSPACE_HOST_LOCATION` | Docker runner | Absolute host path of the workspace, mounted at the same path in the container. Required. Checkpoints live in its `snapshots/` directory. |
| `COPILOT_API_URL` | provider registry | Base URL of the provider proxy; OpenRouter requests go to its `/api/providers/openrouter/` route. When unset, they go to `http://localhost:$PORT`. |
| `PORT` | provider registry | Port of the local provider proxy used when `COPILOT_API_URL` is unset (default `3000`). |
| `OPENROUTER_API_KEY` | provider registry, proxy | Key for the `openrouter` provider (the registry falls back to the key passed to `ProviderRegistry`); the proxy uses it to call OpenRouter. |
| `OPENROUTER_BASE_URL` | provider registry | Overrides the OpenRouter base URL. |

## Development

```bash
npm install        # also builds dist/ via the prepare script
npm run lint       # tsc, ESLint, check-explicit-any, boundary guard
npm test           # vitest, one file at a time
npm run build      # dist/: ESM bundles plus .d.ts
npm run verify:docker  # Docker runner against a real, throwaway container
```

Integration tests replay recorded model traffic through `test/harness/CapiProxy.ts`
(see `docs/copilot-sdk-record-replay.md`). `npm test` needs no Docker or network access:
its Docker runner tests mock `child_process`. `npm run verify:docker` checks the runner
against a real container and needs a running Docker daemon; `ci/check.sh` runs it, so the
merge gate needs Docker locally and in CI.
