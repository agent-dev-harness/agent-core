# @agent-dev-harness/agent-core

agent-core is a private TypeScript library that runs AI agent sessions on the GitHub
Copilot SDK. It has four parts:

| Part | What it does |
|---|---|
| **Sessions** | `SessionWrapper` is the only way to create or resume a session. The tool list is fixed when the session is created, and tools are switched on and off through permissions. That keeps the prompt cache valid across resumes. The SDK is only imported in `boundary.ts`. |
| **Forced tool turns** | `runForcedToolTurnUntilTimeout` makes the model answer by calling a named tool. It nudges and retries if the model doesn't. A timeout only frees the caller: the turn keeps running. |
| **Workspace** | Docker and native runners, the `run_terminal_docker` tool (working directory, timeouts, output truncation), killing the whole process group on abort, and `GitSandbox`. |
| **Providers** | `ProviderRegistry` plus an HTTP proxy that routes models to OpenAI, Anthropic, OpenRouter, Gemini or a local server. |

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
- For Docker mode, a running container reachable as `CONTAINER_NAME` with the workspace
  bind-mounted at the same absolute path as on the host (see `WORKSPACE_HOST_LOCATION`).

## Entrypoints

| Import | Contents |
|---|---|
| `@agent-dev-harness/agent-core` | `SessionWrapper`, `CopilotClient`, `defineTool` and the re-exported SDK types; `runForcedToolTurnUntilTimeout`; context helpers (`SlidingWindowCircularBuffer`, `enforceWorkingMemoryTruncation`, `cleanSubprocessLogs`, `clearCleanCache`); exec-tool helpers (`makeRunTerminalDockerHandler`, `parseExecToolArgs`, `buildExecOptions`, `truncateExecResult`); `ProviderRegistry` and its config types; `PROVIDERS`, `isProviderType`, `ModelProviderConfig`, `RUN_TERMINAL_DOCKER_TOOL` |
| `@agent-dev-harness/agent-core/workspace` | `initializeWorkspace`, `selectWorkspaceRunner`, `WorkspaceRunner`, `getExecCommand`, `getGitSandbox`, `getWorkspaceRoot`, `getWorkspaceHostLocation`, `resolveWorkDir`, `TRAVERSAL_ERROR`, `GitSandbox`, `killProcessGroup` |
| `@agent-dev-harness/agent-core/proxy` | `mountProviderProxyRoute`, `setActiveOpenRouterSessionId` (needs `express`, an optional peer dependency) |
| `@agent-dev-harness/agent-core/types` | Type-only exports, safe to import from browser code |
| `@agent-dev-harness/agent-core/testing` | `nativeRunner`, for test harnesses that drive the native runner directly |

Call `initializeWorkspace()` once at startup before using the workspace functions or
`makeRunTerminalDockerHandler`. Commands run in Docker unless the caller picks the native
runner, which runs them on the host: `initializeWorkspace({ runner: 'native' })` or
`selectWorkspaceRunner('native')`. The runner can't change once the workspace is initialized.
To subclass `GitSandbox` (for example, to add branch-per-task
operations), pass `initializeWorkspace({ createSandbox })`.

## Environment variables

The package reads these at runtime. Everything else, including model and role
configuration, is passed in by the caller.

| Variable | Read by | Effect |
|---|---|---|
| `VITEST` | provider registry | When `true` and `COPILOT_API_URL` is set, the registry routes every provider through it (otherwise only `openai`). |
| `CONTAINER_NAME` | Docker runner | Name of the container commands run in. |
| `WORKSPACE_HOST_LOCATION` | Docker runner | Absolute host path of the workspace, mounted at the same path in the container. Required in Docker mode. |
| `COPILOT_API_URL` | provider registry | Base URL of the provider proxy. When unset, providers route to `http://localhost:$PORT`. |
| `PORT` | provider registry | Port of the local provider proxy used when `COPILOT_API_URL` is unset (default `3000`). |
| `OPENAI_API_KEY` | provider registry | Key for the `openai` provider (falls back to the key passed to `ProviderRegistry`). |
| `ANTHROPIC_API_KEY` | provider registry | Key for the `anthropic` provider (same fallback). |
| `OPENROUTER_API_KEY` | provider registry, proxy | Key for the `openrouter` provider (same fallback in the registry); the proxy uses it to call OpenRouter. |
| `OPENROUTER_BASE_URL` | provider registry | Overrides the OpenRouter base URL. |
| `LOCAL_PROVIDER_URL` | provider registry | Base URL of a local OpenAI-compatible server (default `http://127.0.0.1:11434/v1/`). |
| `LOCAL_PROVIDER_API_KEY` | provider registry | Key for the local provider (default `ollama`). |

The Gemini provider takes its key only from the `ProviderRegistry` constructor; the
package does not read `GEMINI_API_KEY` itself.

## Known limitations

- The proxy keeps the active OpenRouter session id in module-level state
  (`setActiveOpenRouterSessionId`), so it is only correct for one session at a time per
  process.
- `VITEST` changes provider routing inside production code.

## Development

```bash
npm install        # also builds dist/ via the prepare script
npm run lint       # tsc, ESLint, check-explicit-any, boundary guard
npm test           # vitest, one file at a time
npm run build      # dist/: ESM bundles plus .d.ts
npm run verify:docker  # Docker runner against a real, throwaway container
```

Integration tests replay recorded model traffic through `test/harness/CapiProxy.ts`
(see `docs/copilot-sdk-record-replay.md`). No test needs Docker or network access: the
Docker runner tests mock `child_process`; `npm run verify:docker` checks the runner
against a real container and needs a running Docker daemon.
