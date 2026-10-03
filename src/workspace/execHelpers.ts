import * as path from "node:path";

export type ExecResult = { stdout: string; stderr: string; exitCode: number | null };

export interface ExecOptions {
  workDir?: string;
  timeoutMs?: number;
}

export const TRAVERSAL_ERROR =
  "Error: Directory path traversal detected. Access denied outside workspace boundaries.";

export type ResolvedWorkDir = { ok: true; dir: string } | { ok: false; error: string };

export function resolveWorkDir(
  requested: string | undefined,
  workspaceRoot: string,
): ResolvedWorkDir {
  if (!requested || !requested.trim()) return { ok: true, dir: workspaceRoot };
  const absolute = path.isAbsolute(requested)
    ? path.normalize(requested)
    : path.resolve(workspaceRoot, requested);
  const rootWithSep = workspaceRoot.endsWith(path.sep) ? workspaceRoot : workspaceRoot + path.sep;
  if (absolute !== workspaceRoot && !absolute.startsWith(rootWithSep)) {
    return { ok: false, error: TRAVERSAL_ERROR };
  }
  return { ok: true, dir: absolute };
}

export function shellQuotePath(p: string): string {
  return `'` + p.replace(/'/g, `'\\''`) + `'`;
}

export function prependWorkDir(command: string, dir: string, workspaceRoot: string): string {
  if (dir === workspaceRoot) return command;
  return `cd ${shellQuotePath(dir)} || exit 91\n${command}`;
}

export function annotateTimeout(
  result: ExecResult,
  timeoutSignal: AbortSignal,
  timeoutMs: number,
): ExecResult {
  const reason = timeoutSignal.reason as { name?: string } | undefined;
  const timedOut = timeoutSignal.aborted && reason?.name === "TimeoutError" && result.exitCode === null;
  if (!timedOut) return result;
  const note = `[run_terminal_docker] Command timed out after ${Math.round(timeoutMs / 1000)}s and was killed.`;
  return {
    ...result,
    exitCode: 124,
    stderr: result.stderr ? `${result.stderr}\n${note}` : note,
  };
}

export async function execWithDefaults(
  run: (command: string, signal?: AbortSignal, workDir?: string) => Promise<ExecResult>,
  command: string,
  signal: AbortSignal | undefined,
  opts: ExecOptions | undefined,
  defaultTimeoutMs: number,
): Promise<ExecResult> {
  if (opts?.timeoutMs !== undefined) {
    const timeoutSignal = AbortSignal.timeout(opts.timeoutMs);
    const effectiveSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const result = await run(command, effectiveSignal, opts?.workDir);
    return annotateTimeout(result, timeoutSignal, opts.timeoutMs);
  }
  if (signal) return run(command, signal, opts?.workDir);
  const timeoutSignal = AbortSignal.timeout(defaultTimeoutMs);
  const result = await run(command, timeoutSignal, opts?.workDir);
  return annotateTimeout(result, timeoutSignal, defaultTimeoutMs);
}
