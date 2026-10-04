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

// Reading the whole script before running it means a command that reads stdin gets EOF
// instead of the lines after it. --norc because bash -c sources bashrc when stdin is a
// socket, which Node's stdin pipes are.
export function bashScriptArgs(setup = ""): string[] {
  return ["--norc", "-c", `${setup}__run_terminal_script=$(cat); eval "$__run_terminal_script" </dev/null`];
}

export function shellQuotePath(p: string): string {
  return `'` + p.replace(/'/g, `'\\''`) + `'`;
}

// resolveWorkDir only checks the path text, so a symlink could still lead outside; this
// checks the physical directory in the shell that runs the command.
export function prependWorkDir(command: string, dir: string, workspaceRoot: string): string {
  if (dir === workspaceRoot) return command;
  return (
    `cd ${shellQuotePath(dir)} || exit 91\n` +
    `case "$(pwd -P)/" in "$(cd ${shellQuotePath(workspaceRoot)} && pwd -P)"/*) ;; ` +
    `*) echo ${shellQuotePath(TRAVERSAL_ERROR)} >&2; exit 1 ;; esac\n` +
    command
  );
}

const DEFAULT_OUTPUT_LIMIT: OutputLimit = {
  maxChars: 64 * 2 ** 20,
  headChars: 32 * 2 ** 20,
  tailChars: 32 * 2 ** 20,
};

function truncationNotice(omittedChars: number): string {
  return `\n[run_terminal_docker] Output truncated: omitted ${omittedChars} middle characters.\n`;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export class OutputCollector {
  private readonly decoder = new StringDecoder("utf8");
  private head = "";
  private tail: string[] = [];
  private tailLength = 0;
  private totalLength = 0;

  constructor(private readonly limit: OutputLimit = DEFAULT_OUTPUT_LIMIT) {}

  write(chunk: Buffer | string): void {
    this.append(typeof chunk === "string" ? chunk : this.decoder.write(chunk));
  }

  finish(): string {
    this.append(this.decoder.end());
    const tail = this.tail.join("");
    if (this.totalLength <= this.limit.maxChars) return this.head + tail;
    let head = this.head;
    let kept = tail.slice(tail.length - this.limit.tailChars);
    if (isHighSurrogate(head.charCodeAt(head.length - 1))) head = head.slice(0, -1);
    if (isLowSurrogate(kept.charCodeAt(0))) kept = kept.slice(1);
    return head + truncationNotice(this.totalLength - head.length - kept.length) + kept;
  }

  private append(text: string): void {
    this.totalLength += text.length;
    if (this.head.length < this.limit.headChars) {
      const room = this.limit.headChars - this.head.length;
      this.head += text.slice(0, room);
      text = text.slice(room);
    }
    if (!text) return;
    this.tail.push(text);
    this.tailLength += text.length;
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
