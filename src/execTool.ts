import type { OutputLimit } from "./workspace";
import { getWorkspaceRoot, resolveWorkDir } from "./workspace";
import { OutputCollector } from "./workspace/execHelpers";
import type { DockerRun } from "./workspace/dockerRunner";
import { getStartCommand } from "./workspace/workspace";

export const MIN_WAIT_SECONDS = 0;
export const MAX_WAIT_SECONDS = 600;
export const DEFAULT_INITIAL_WAIT_SECONDS = 60;
export const DEFAULT_READ_WAIT_SECONDS = 10;
export const DEFAULT_WRITE_WAIT_SECONDS = 2;

export const MAX_TOOL_OUTPUT_CHARS = 40_000;
const TRUNCATE_HEAD_CHARS = 26_000;
const TRUNCATE_TAIL_CHARS = 13_000;
const TOOL_OUTPUT_LIMIT: OutputLimit = {
  maxChars: MAX_TOOL_OUTPUT_CHARS,
  headChars: TRUNCATE_HEAD_CHARS,
  tailChars: TRUNCATE_TAIL_CHARS,
};

const MAX_LISTED_COMMAND_CHARS = 200;

export type ExecMode = "sync" | "async";

export interface ParsedExecToolArgs {
  command: string;
  workDir?: string;
  initialWaitMs: number;
  mode: ExecMode;
}

export interface TerminalResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  shellId?: string;
  status?: "running" | "exited";
  note?: string;
}

function asRecord(args: unknown): Record<string, unknown> {
  return (args !== null && typeof args === "object" ? args : {}) as Record<string, unknown>;
}

// Models often send numbers as strings ("120"), so a numeric string counts as a number.
function readSeconds(raw: unknown, fallback: number): number {
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_WAIT_SECONDS, Math.max(MIN_WAIT_SECONDS, value));
}

export function parseExecToolArgs(args: unknown): ParsedExecToolArgs {
  const record = asRecord(args);
  const command = typeof record.command === "string" ? record.command : "";
  const workDir = typeof record.workingDir === "string" ? record.workingDir : undefined;
  const initialWaitMs = readSeconds(record.initialWaitSeconds, DEFAULT_INITIAL_WAIT_SECONDS) * 1000;
  const mode: ExecMode = record.mode === "async" ? "async" : "sync";
  return { command, workDir, initialWaitMs, mode };
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

function usageError(stderr: string): TerminalResult {
  return { stdout: "", stderr, exitCode: 2 };
}

function describeKeys(record: Record<string, unknown>): string {
  const keys = Object.keys(record);
  return keys.length ? keys.join(", ") : "none";
}

type WaitOutcome = "exited" | "waiting" | "aborted";

function waitForExit(run: DockerRun, ms: number, signal?: AbortSignal): Promise<WaitOutcome> {
  if (signal?.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish("waiting"), ms);
    const onAbort = () => finish("aborted");
    signal?.addEventListener("abort", onAbort);
    void run.exited.then(() => finish("exited"));
    function finish(outcome: WaitOutcome) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    }
  });
}

interface TerminalEntry {
  readonly shellId: string;
  readonly command: string;
  readonly startedAt: number;
  readonly run: DockerRun;
  exitCode: number | null | undefined;
}

export interface TerminalDockerHandlers {
  run_terminal_docker(args: unknown, invocation?: { abortSignal?: AbortSignal }): Promise<TerminalResult>;
  read_terminal_docker(args: unknown): Promise<TerminalResult>;
  write_terminal_docker(args: unknown): Promise<TerminalResult>;
  stop_terminal_docker(args: unknown): Promise<TerminalResult>;
  list_terminal_docker(args?: unknown): Promise<{ terminals: TerminalListing[] }>;
  // Kills every command still running. abortSignal does this when it fires.
  stopAll(): Promise<void>;
}

export interface TerminalListing {
  shellId: string;
  command: string;
  status: "running" | "exited";
  exitCode: number | null;
  runningSeconds: number;
}

// One set of handlers per session: shellIds are only visible to the handlers that started them.
// abortSignal is session-scoped; when it fires, every command still running is killed.
export function makeTerminalDockerHandlers(abortSignal?: AbortSignal): TerminalDockerHandlers {
  const terminals = new Map<string, TerminalEntry>();
  let nextId = 1;

  const stopAll = async (): Promise<void> => {
    await Promise.all([...terminals.values()].map((t) => t.run.kill()));
  };
  abortSignal?.addEventListener("abort", () => void stopAll(), { once: true });

  const register = (command: string, run: DockerRun): TerminalEntry => {
    const entry: TerminalEntry = { shellId: `shell-${nextId++}`, command, startedAt: Date.now(), run, exitCode: undefined };
    void run.exited.then((code) => {
      entry.exitCode = code;
    });
    terminals.set(entry.shellId, entry);
    if (abortSignal?.aborted) void run.kill();
    return entry;
  };

  const lookup = (args: unknown, tool: string): TerminalEntry | TerminalResult => {
    const record = asRecord(args);
    const shellId = typeof record.shellId === "string" ? record.shellId : "";
    const entry = terminals.get(shellId);
    if (entry) return entry;
    const known = [...terminals.keys()];
    return usageError(
      shellId
        ? `${tool}: no terminal with shellId '${shellId}'. ` +
            (known.length ? `Known shellIds: ${known.join(", ")}.` : "No terminals are running.") +
            " A terminal is forgotten once its exit has been reported."
        : `${tool}: missing required argument 'shellId' (got: ${describeKeys(record)}).`,
    );
  };

  // Reports output since the last report; once the exit has been reported the terminal is dropped.
  const report = (entry: TerminalEntry, note?: string): TerminalResult => {
    const output = entry.run.takeOutput();
    if (entry.exitCode === undefined) {
      return { ...output, exitCode: null, shellId: entry.shellId, status: "running", ...(note ? { note } : {}) };
    }
    terminals.delete(entry.shellId);
    return { ...output, exitCode: entry.exitCode, shellId: entry.shellId, status: "exited", ...(note ? { note } : {}) };
  };

  const settle = async (entry: TerminalEntry, outcome: WaitOutcome): Promise<void> => {
    if (outcome === "exited") entry.exitCode = await entry.run.exited;
  };

  return {
    async run_terminal_docker(args, invocation) {
      const record = asRecord(args);
      const parsed = parseExecToolArgs(args);
      if (!parsed.command.trim()) {
        return usageError(
          `run_terminal_docker: missing required argument 'command' (got: ${describeKeys(record)}). ` +
            "Pass the bash script to run as 'command'.",
        );
      }
      const resolved = resolveWorkDir(parsed.workDir, getWorkspaceRoot());
      if (!resolved.ok) {
        return { stdout: "", stderr: resolved.error, exitCode: 1 };
      }
      const run = getStartCommand()(parsed.command, {
        workDir: resolved.dir,
        outputLimit: TOOL_OUTPUT_LIMIT,
        keepStdinOpen: parsed.mode === "async",
      });

      if (parsed.mode === "async") {
        const entry = register(parsed.command, run);
        return report(
          entry,
          `Started in the background. Use read_terminal_docker with shellId "${entry.shellId}" for its output and exit code, ` +
            "write_terminal_docker to send it input, and stop_terminal_docker to stop it.",
        );
      }

      const signals = [abortSignal, invocation?.abortSignal].filter((s): s is AbortSignal => s !== undefined);
      const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
      const outcome = await waitForExit(run, parsed.initialWaitMs, signal);
      if (outcome === "aborted") await run.kill();
      if (outcome !== "waiting") {
        return { ...run.takeOutput(), exitCode: await run.exited };
      }
      const entry = register(parsed.command, run);
      return report(
        entry,
        `Still running after ${Math.round(parsed.initialWaitMs / 1000)}s; it keeps running in the background. ` +
          `Use read_terminal_docker with shellId "${entry.shellId}" to wait for more output and the exit code, ` +
          "or stop_terminal_docker to stop it.",
      );
    },

    async read_terminal_docker(args) {
      const entry = lookup(args, "read_terminal_docker");
      if (!("run" in entry)) return entry;
      const waitMs = readSeconds(asRecord(args).waitSeconds, DEFAULT_READ_WAIT_SECONDS) * 1000;
      if (entry.exitCode === undefined) await settle(entry, await waitForExit(entry.run, waitMs));
      return report(entry);
    },

    async write_terminal_docker(args) {
      const entry = lookup(args, "write_terminal_docker");
      if (!("run" in entry)) return entry;
      const record = asRecord(args);
      const input = typeof record.input === "string" ? record.input : "";
      const endInput = record.endInput === true || record.endInput === "true";
      if (input && !entry.run.write(input)) {
        return {
          ...report(entry),
          note: "Input was not sent: this command's stdin is closed. Only commands started with mode \"async\" take input, until endInput or exit.",
        };
      }
      if (endInput) entry.run.closeStdin();
      const waitMs = readSeconds(record.waitSeconds, DEFAULT_WRITE_WAIT_SECONDS) * 1000;
      if (entry.exitCode === undefined) await settle(entry, await waitForExit(entry.run, waitMs));
      return report(entry);
    },

    async stop_terminal_docker(args) {
      const entry = lookup(args, "stop_terminal_docker");
      if (!("run" in entry)) return entry;
      if (entry.exitCode === undefined) {
        await entry.run.kill();
        entry.exitCode = await entry.run.exited;
      }
      return report(entry, "Stopped.");
    },

    async list_terminal_docker() {
      const now = Date.now();
      return {
        terminals: [...terminals.values()].map((t) => ({
          shellId: t.shellId,
          command: t.command.length > MAX_LISTED_COMMAND_CHARS ? `${t.command.slice(0, MAX_LISTED_COMMAND_CHARS)}…` : t.command,
          status: t.exitCode === undefined ? ("running" as const) : ("exited" as const),
          exitCode: t.exitCode ?? null,
          runningSeconds: Math.round((now - t.startedAt) / 1000),
        })),
      };
    },

    stopAll,
  };
}

/** @deprecated Registers only run_terminal_docker, so a command still running after its initial wait can't be read or stopped. Use makeTerminalDockerHandlers. */
export function makeRunTerminalDockerHandler(abortSignal?: AbortSignal) {
  return makeTerminalDockerHandlers(abortSignal).run_terminal_docker;
}
