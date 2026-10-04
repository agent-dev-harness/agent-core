import type { ExecOptions, OutputLimit } from "./workspace";
import { getExecCommand, getWorkspaceRoot, resolveWorkDir } from "./workspace";
import { OutputCollector } from "./workspace/execHelpers";

export const MIN_TIMEOUT_SECONDS = 30;
export const MAX_TIMEOUT_SECONDS = 600;

// Always applied: handlers pass a session-scoped abort signal that only fires on
// teardown, so without a timeout a hung command would never be killed.
export const DEFAULT_TIMEOUT_SECONDS = 60;

export const MAX_TOOL_OUTPUT_CHARS = 40_000;
const TRUNCATE_HEAD_CHARS = 26_000;
const TRUNCATE_TAIL_CHARS = 13_000;
const TOOL_OUTPUT_LIMIT: OutputLimit = {
  maxChars: MAX_TOOL_OUTPUT_CHARS,
  headChars: TRUNCATE_HEAD_CHARS,
  tailChars: TRUNCATE_TAIL_CHARS,
};

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
  const collector = new OutputCollector(TOOL_OUTPUT_LIMIT);
  collector.write(text);
  return collector.finish();
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
  const opts: ExecOptions = { timeoutMs: parsed.timeoutMs, outputLimit: TOOL_OUTPUT_LIMIT };
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
