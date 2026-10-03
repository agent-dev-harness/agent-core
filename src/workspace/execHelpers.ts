import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";

export type ExecResult = { stdout: string; stderr: string; exitCode: number | null };

export interface OutputLimit {
  maxChars: number;
  headChars: number;
  tailChars: number;
}

export interface ExecOptions {
  workDir?: string;
  timeoutMs?: number;
  outputLimit?: OutputLimit;
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

function truncationNotice(omittedChars: number): string {
  return `\n[run_terminal_docker] Output truncated: omitted ${omittedChars} middle characters.\n`;
}

export class OutputCollector {
  private readonly decoder = new StringDecoder("utf8");
  private head = "";
  private tail: string[] = [];
  private tailLength = 0;
  private totalLength = 0;

  constructor(private readonly limit?: OutputLimit) {}

  write(chunk: Buffer | string): void {
    this.append(typeof chunk === "string" ? chunk : this.decoder.write(chunk));
  }

  finish(): string {
    this.append(this.decoder.end());
    const tail = this.tail.join("");
    if (!this.limit || this.totalLength <= this.limit.maxChars) return this.head + tail;
    const { headChars, tailChars } = this.limit;
    return (
      this.head +
      truncationNotice(this.totalLength - headChars - tailChars) +
      tail.slice(tail.length - tailChars)
    );
  }

  private append(text: string): void {
    this.totalLength += text.length;
    if (this.limit && this.head.length < this.limit.headChars) {
      const room = this.limit.headChars - this.head.length;
      this.head += text.slice(0, room);
      text = text.slice(room);
    }
    if (!text) return;
    this.tail.push(text);
    this.tailLength += text.length;
    if (!this.limit) return;
    const keep = this.limit.maxChars - this.limit.headChars;
    for (let oldest = this.tail[0]; oldest !== undefined && this.tailLength - oldest.length >= keep; oldest = this.tail[0]) {
      this.tail.shift();
      this.tailLength -= oldest.length;
    }
  }
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
  run: (
    command: string,
    signal?: AbortSignal,
    workDir?: string,
    outputLimit?: OutputLimit,
  ) => Promise<ExecResult>,
  command: string,
  signal: AbortSignal | undefined,
  opts: ExecOptions | undefined,
  defaultTimeoutMs: number,
): Promise<ExecResult> {
  if (opts?.timeoutMs !== undefined) {
    const timeoutSignal = AbortSignal.timeout(opts.timeoutMs);
    const effectiveSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const result = await run(command, effectiveSignal, opts?.workDir, opts?.outputLimit);
    return annotateTimeout(result, timeoutSignal, opts.timeoutMs);
  }
  if (signal) return run(command, signal, opts?.workDir, opts?.outputLimit);
  const timeoutSignal = AbortSignal.timeout(defaultTimeoutMs);
  const result = await run(command, timeoutSignal, opts?.workDir, opts?.outputLimit);
  return annotateTimeout(result, timeoutSignal, defaultTimeoutMs);
}
