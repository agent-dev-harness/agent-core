# @agent-dev-harness/agent-core

agent-core is a private TypeScript library that runs AI agent sessions on the GitHub
Copilot SDK. It has four parts:

| Part | What it does |
|---|---|
| **Sessions** | `SessionWrapper` is the only way to create or resume a session. The tool list is fixed when the session is created, and tools are switched on and off through permissions. That keeps the prompt cache valid across resumes. The SDK is only imported in `boundary.ts`. |
| **Forced tool turns** | `runForcedToolTurnUntilTimeout` makes the model answer by calling a named tool. It nudges and retries if the model doesn't. A timeout only frees the caller: the turn keeps running. |
| **Workspace** | The Docker runner, the `run_terminal_docker` tool (working directory, timeouts, output truncation), killing the whole process group on abort, and `GitSandbox`. |
| **Providers** | `ProviderRegistry` plus an HTTP proxy. Bring-your-own-key models go through OpenRouter; a model configured as `copilot-native` uses Copilot's own models with no provider config. A model the registry has no config for routes to OpenRouter, and with no model and no `tierModels` it throws. |

## Goals

0. **Most important requirement:** `run_terminal_docker` completely replaces the bash tool.
1. **One way in for anything risky:** SDK imports, session creation and workspace paths each
   have one allowed route, and lint checks enforce it.
2. **No hangs:** every `run_terminal_docker` command has a deadline.
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

## Installing

The package isn't published to a registry. Install it from GitHub, pinned to a release tag
or a commit:

```bash
npm install github:agent-dev-harness/agent-core#v0.2.0
```

npm builds `dist/` during the install (the `prepare` script), which takes about 40 seconds.
No SSH key or token is needed. To upgrade, change the tag. `@github/copilot-sdk` is pinned
to an exact version, so consumers get the SDK this repo's tests ran against.

To release, bump `version` in `package.json` in a PR. When it merges, CI runs the merge
gate on `main` and tags that commit `v<version>`.

## Entrypoints

| Import | Contents |
|---|---|
| `@agent-dev-harness/agent-core` | `SessionWrapper`, `TurnToolInvocation`, `CopilotClient`, `defineTool` and the re-exported SDK types; `runForcedToolTurnUntilTimeout`; context helpers (`SlidingWindowCircularBuffer`, `enforceWorkingMemoryTruncation`, `cleanSubprocessLogs`, `clearCleanCache`); exec-tool helpers (`makeRunTerminalDockerHandler`, `parseExecToolArgs`, `buildExecOptions`, `truncateExecResult`); `ProviderRegistry` and its config types, `OPENROUTER_SESSION_ID_HEADER`; `PROVIDERS`, `isProviderType`, `ModelProviderConfig`, `RUN_TERMINAL_DOCKER_TOOL` |
| `@agent-dev-harness/agent-core/workspace` | `initializeWorkspace`, `getExecCommand`, `getGitSandbox`, `getWorkspaceRoot`, `getWorkspaceHostLocation`, `resolveWorkDir`, `TRAVERSAL_ERROR`, `GitSandbox`, `killProcessGroup` |
| `@agent-dev-harness/agent-core/proxy` | `mountProviderProxyRoute`, `OPENROUTER_SESSION_ID_HEADER` (needs `express`, an optional peer dependency) |
| `@agent-dev-harness/agent-core/types` | Type-only exports, safe to import from browser code |

Call `initializeWorkspace()` once at startup before using the workspace functions or
`makeRunTerminalDockerHandler`. Commands always run in the Docker container. To subclass `GitSandbox` (for example, to add branch-per-task
operations), pass `initializeWorkspace({ createSandbox })`.

`SessionWrapper` passes each custom tool handler a `TurnToolInvocation`, whose `abortSignal`
fires when the turn is aborted (`session.abort()`). A handler from
`makeRunTerminalDockerHandler` kills its command when that signal fires, so pass the
invocation through if you wrap it: `defineTool(name, description, parameters, (args, invocation) => handler(args, invocation))`.

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
| `WORKSPACE_HOST_LOCATION` | Docker runner | Absolute host path of the workspace, mounted at the same path in the container. Required. |
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
