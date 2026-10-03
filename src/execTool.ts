import type { ExecOptions } from "./workspace";
import { getExecCommand, getWorkspaceRoot, resolveWorkDir } from "./workspace";

export const MIN_TIMEOUT_SECONDS = 30;
export const MAX_TIMEOUT_SECONDS = 600;

// Always applied: handlers pass a session-scoped abort signal that only fires on
// teardown, so without a timeout a hung command would never be killed.
export const DEFAULT_TIMEOUT_SECONDS = 60;

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

export function makeRunTerminalDockerHandler(abortSignal?: AbortSignal) {
  return async (args: unknown) => {
    const parsed = parseExecToolArgs(args);
    const resolved = resolveWorkDir(parsed.workDir, getWorkspaceRoot());
    if (!resolved.ok) {
      return { stdout: '', stderr: resolved.error, exitCode: 1 };
    }
    const execCommand = getExecCommand();
    const result = await execCommand(parsed.command, abortSignal, buildExecOptions(parsed, resolved.dir));
    return truncateExecResult(result);
  };
}
