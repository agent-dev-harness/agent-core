import type { ExecOptions } from "./workspace";
import { getExecCommand, getWorkspaceRoot, resolveWorkDir } from "./workspace";

/**
 * Shared boundary between the `run_terminal_docker` tool arguments (LLM
 * supplied) and the workspace exec runners. Every handler for the tool
 * (`makeRunTerminalDockerHandler` here, and any a caller writes, such as one
 * that streams results) funnels its args through this module so the entry
 * points can't drift apart on parsing, clamping, or output capping.
 */

// Bash-tool parity: the model may extend the deadline per call, within the
// same 30s..600s window the bash tool allows for initial_wait.
export const MIN_TIMEOUT_SECONDS = 30;
export const MAX_TIMEOUT_SECONDS = 600;

// Deadline applied when the model omits timeoutSeconds. This MUST always be
// threaded into `opts.timeoutMs` (never left undefined) so it composes with
// whatever AbortSignal the call site passes in — production handlers pass a
// session-scoped signal that only fires on teardown, not on a timer, so an
// undefined timeoutMs here means execWithDefaults enforces no deadline at
// all. Internal callers that invoke `execCommand` directly (bypassing this
// module, e.g. gates) are unaffected and keep owning their own deadline.
export const DEFAULT_TIMEOUT_SECONDS = 60;

// Cap on what a single exec tool result will feed back into the model
// context. Without it, a chatty command (a test run with no pipe, a
// runaway loop) streams megabytes straight into the conversation — the SDK
// session configs this was written for didn't set `largeOutput`, so there is no
// downstream truncation to absorb it.
export const MAX_TOOL_OUTPUT_CHARS = 40_000;
const TRUNCATE_HEAD_CHARS = 26_000;
const TRUNCATE_TAIL_CHARS = 13_000;

export interface ParsedExecToolArgs {
  command: string;
  workDir?: string;
  timeoutMs: number;
}

export function parseExecToolArgs(args: unknown): ParsedExecToolArgs {
  const record = (args ?? {}) as Record<string, unknown>;
  const command = typeof record.command === "string" ? record.command : "";
  const workDir = typeof record.workingDir === "string" ? record.workingDir : undefined;

  const rawTimeout = record.timeoutSeconds;
  const timeoutSeconds =
    typeof rawTimeout === "number" && Number.isFinite(rawTimeout)
      ? Math.min(MAX_TIMEOUT_SECONDS, Math.max(MIN_TIMEOUT_SECONDS, rawTimeout))
      : DEFAULT_TIMEOUT_SECONDS;
  const timeoutMs = timeoutSeconds * 1000;

  return { command, workDir, timeoutMs };
}

function truncateText(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  const omitted = text.length - (TRUNCATE_HEAD_CHARS + TRUNCATE_TAIL_CHARS);
  return (
    text.slice(0, TRUNCATE_HEAD_CHARS) +
    `\n[run_terminal_docker] Output truncated: omitted ${omitted} middle characters.\n` +
    text.slice(text.length - TRUNCATE_TAIL_CHARS)
  );
}

export function truncateExecResult(result: { stdout: string; stderr: string; exitCode: number | null }): {
  stdout: string;
  stderr: string;
  exitCode: number | null;
} {
  return {
    ...result,
    stdout: truncateText(result.stdout),
    stderr: truncateText(result.stderr),
  };
}

export function buildExecOptions(parsed: ParsedExecToolArgs, workDir: string | undefined): ExecOptions {
  const opts: ExecOptions = { timeoutMs: parsed.timeoutMs };
  if (workDir !== undefined) opts.workDir = workDir;
  return opts;
}

/**
 * Headless (non-SSE) handler for `run_terminal_docker`: a plain
 * request/response tool call, for sessions with no SSE stream to push
 * `tool.result` events onto.
 *
 * Routes through `getExecCommand()` (see SYS-REQ-023), so these sessions get
 * the same GitSandbox locking, GIT_TIMEOUT_MS/EXEC_TIMEOUT_MS enforcement,
 * and Docker-vs-native routing as every other workspace consumer, instead of
 * falling back to the copilot SDK's own default bash/view/edit tools
 * operating directly on `CopilotClient.workingDirectory`.
 */
export function makeRunTerminalDockerHandler(abortSignal?: AbortSignal) {
  return async (args: unknown) => {
    const parsed = parseExecToolArgs(args);
    const resolved = resolveWorkDir(parsed.workDir, getWorkspaceRoot());
    if (!resolved.ok) {
      // Cheap synchronous rejection: no exec process is ever spawned, and
      // getExecCommand() is deliberately not even consulted for this case.
      return { stdout: '', stderr: resolved.error, exitCode: 1 };
    }
    const execCommand = getExecCommand();
    const result = await execCommand(parsed.command, abortSignal, buildExecOptions(parsed, resolved.dir));
    return truncateExecResult(result);
  };
}
