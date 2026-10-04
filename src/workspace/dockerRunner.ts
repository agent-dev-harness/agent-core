import { spawn, spawnSync } from "child_process";
import * as crypto from "crypto";
import * as path from "path";
import { killProcessGroup } from "./processGroup";
import { ExecOptions, OutputLimit, OutputWindow, bashScriptArgs, execWithDefaults, prependWorkDir, resolveWorkDir, shareOutputBudget } from "./execHelpers";

// No default: a guessed path would hide a misconfigured mount instead of failing.
let WORKSPACE_HOST_LOCATION = "";

function getWorkspaceHostLocationOrThrow(): string {
  if (!WORKSPACE_HOST_LOCATION) {
    const raw = process.env.WORKSPACE_HOST_LOCATION || "";
    if (!raw) {
      throw new Error(
        "WORKSPACE_HOST_LOCATION environment variable is not set. Set it to the absolute host path of " +
          "the workspace, which must be bind-mounted at the same path inside CONTAINER_NAME.",
      );
    }
    if (!path.isAbsolute(raw)) {
      throw new Error(
        `WORKSPACE_HOST_LOCATION must be an absolute path (got "${raw}"); the workspace is mounted at the ` +
          "same absolute path inside the container.",
      );
    }
    // Workspace path checks compare against this string, so "/ws/" and "/ws/./" must become "/ws".
    WORKSPACE_HOST_LOCATION = path.resolve(raw);
  }
  return WORKSPACE_HOST_LOCATION;
}

const EXEC_TIMEOUT_MS = 60_000;

// A second run marker that survives env -i and reparenting: an inherited descriptor on a file
// that is deleted at once. Only a process that also closes its inherited descriptors loses it.
const RUN_MARKER_FD_SETUP =
  '{ : >"/tmp/.exec-run-$EXEC_RUN_ID" && exec 987<"/tmp/.exec-run-$EXEC_RUN_ID"; rm -f "/tmp/.exec-run-$EXEC_RUN_ID"; } 2>/dev/null; ';

let CONTAINER_NAME = "";

function getContainerName(): string {
  if (!CONTAINER_NAME) {
    CONTAINER_NAME = process.env.CONTAINER_NAME || "";
    if (!CONTAINER_NAME) {
      throw new Error(
        "CONTAINER_NAME environment variable is not set. Please ensure the container name is provided.",
      );
    }
  }
  return CONTAINER_NAME;
}

let workspaceMountVerified = false;

const VERIFY_MOUNT_TIMEOUT_MS = 5_000;

function verifyWorkspaceMount(): void {
  if (workspaceMountVerified) return;
  const location = getWorkspaceHostLocationOrThrow();
  const containerName = getContainerName();
  const result = spawnSync("docker", ["exec", containerName, "test", "-d", location], {
    timeout: VERIFY_MOUNT_TIMEOUT_MS,
    killSignal: "SIGKILL",
    encoding: "utf-8",
  });
  if (result.signal || (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    throw new Error(
      `Timed out after ${VERIFY_MOUNT_TIMEOUT_MS}ms verifying WORKSPACE_HOST_LOCATION ("${location}") inside ` +
        `container "${containerName}"${result.signal ? ` (docker exec was killed with ${result.signal})` : ""}. ` +
        "The docker daemon or container may be unresponsive.",
    );
  }
  if (result.error) {
    throw new Error(
      `Failed to verify WORKSPACE_HOST_LOCATION ("${location}") inside container "${containerName}": ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    const looksLikeDockerCliFailure =
      /No such container|is not running|Cannot connect to the Docker daemon/i.test(stderr);
    if (looksLikeDockerCliFailure) {
      throw new Error(
        `Could not verify WORKSPACE_HOST_LOCATION inside container "${containerName}": docker exec failed before ` +
          `it could check the path (${stderr || `exit code ${result.status}`}). Ensure the container is running ` +
          "before executing commands.",
      );
    }
    throw new Error(
      `WORKSPACE_HOST_LOCATION ("${location}") does not exist inside container "${containerName}"` +
        `${stderr ? `: ${stderr}` : ""}. ` +
        "This usually means the container was mounted with a different WORKSPACE_HOST_LOCATION than the one " +
        "currently set (e.g. a stale value from a previous job, or a step exporting a path different from the " +
        "one `docker compose up` used). Ensure every step that sets CONTAINER_NAME/WORKSPACE_HOST_LOCATION uses " +
        "the exact same value the container was started with.",
    );
  }
  workspaceMountVerified = true;
}

// A command started in the container. Output is read in windows: each takeOutput() returns what
// arrived since the previous call, truncated to the output limit, or with maxTotalChars to a
// budget stdout and stderr share.
export interface DockerRun {
  readonly spawned: boolean;
  readonly exited: Promise<number | null>;
  takeOutput(maxTotalChars?: number): { stdout: string; stderr: string };
  write(input: string): boolean;
  closeStdin(): void;
  kill(): Promise<void>;
}

export interface StartOptions {
  workDir?: string;
  outputLimit?: OutputLimit;
  // Leaves the command's stdin open for write(); otherwise it gets end-of-file.
  keepStdinOpen?: boolean;
}

function finishedRun(stderr: string, exitCode: number, outputLimit?: OutputLimit): DockerRun {
  const err = new OutputWindow(outputLimit);
  err.write(stderr);
  return {
    spawned: false,
    exited: Promise.resolve(exitCode),
    takeOutput: () => ({ stdout: "", stderr: err.take() }),
    write: () => false,
    closeStdin: () => {},
    kill: () => Promise.resolve(),
  };
}

export function startDockerProcess(command: string, opts: StartOptions = {}): DockerRun {
  const workspaceRoot = getWorkspaceHostLocationOrThrow();

  if (opts.workDir !== undefined) {
    const resolved = resolveWorkDir(opts.workDir, workspaceRoot);
    if (!resolved.ok) return finishedRun(resolved.error, 1, opts.outputLimit);
    command = prependWorkDir(command, resolved.dir, workspaceRoot);
  }

  verifyWorkspaceMount();

  const runId = crypto.randomUUID();
  const child = spawn("docker", [
    "exec",
    "-i",
    "-e",
    `EXEC_RUN_ID=${runId}`,
    "-w",
    workspaceRoot,
    getContainerName(),
    "bash",
    ...bashScriptArgs(RUN_MARKER_FD_SETUP),
  ], { detached: true });

  const CONTAINER_KILL_GRACE_MS = 1500;

  let killInitiated = false;
  let containerCleanupPromise: Promise<void> = Promise.resolve();

  const killChild = (): Promise<void> => {
    if (killInitiated) return containerCleanupPromise;
    killInitiated = true;

    killProcessGroup(child);

    containerCleanupPromise = new Promise<void>((resolveCleanup) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(graceTimer);
        resolveCleanup();
      };
      const graceTimer = setTimeout(settle, CONTAINER_KILL_GRACE_MS);

      try {
        // The host can't signal processes inside the container's PID namespace, so kill them
        // there by run marker (environment or descriptor), plus their descendants, which may
        // have dropped both. The kill shell carries the environment marker and skips itself ($$).
        const killCmd = [
          "declare -A parent doomed",
          "for stat in /proc/[0-9]*/stat; do",
          '  read -r line 2>/dev/null <"$stat" || continue',
          "  fields=(${line##*) })",
          "  pid=${stat#/proc/}",
          '  [ -n "${fields[1]}" ] && parent[${pid%/stat}]=${fields[1]}',
          "done",
          'for pid in $(grep -sl "EXEC_RUN_ID=$EXEC_RUN_ID" /proc/[0-9]*/environ | cut -d/ -f3) \\',
          '    $(find /proc/[0-9]*/fd -lname "/tmp/.exec-run-$EXEC_RUN_ID*" 2>/dev/null | cut -d/ -f3); do',
          '  [ "$pid" = "$$" ] || doomed[$pid]=1',
          "done",
          "added=1",
          'while [ -n "$added" ]; do',
          "  added=",
          '  for pid in "${!parent[@]}"; do',
          '    if [ -z "${doomed[$pid]}" ] && [ -n "${doomed[${parent[$pid]}]}" ]; then doomed[$pid]=1; added=1; fi',
          "  done",
          "done",
          'for pid in "${!doomed[@]}"; do',
          '  kill -9 "$pid" 2>/dev/null || [ ! -e "/proc/$pid" ] || echo "kill-failed pid=$pid" >&2',
          "done",
        ].join("\n");
        const killProc = spawn("docker", [
          "exec",
          "-e",
          `EXEC_RUN_ID=${runId}`,
          getContainerName(),
          "bash",
          "-c",
          killCmd,
        ]);

        let killStderr = "";
        killProc.stderr?.on("data", (data) => {
          killStderr += data.toString();
        });
        killProc.on("error", (err) => {
          console.warn(
            `Container-side kill for EXEC_RUN_ID=${runId} failed to spawn:`,
            err,
          );
          settle();
        });
        killProc.on("close", (code) => {
          if (code !== 0) {
            console.warn(
              `Container-side kill for EXEC_RUN_ID=${runId} exited with code ${code}` +
                (killStderr ? `: ${killStderr.trim()}` : " (possible permission issue or no matching processes)"),
            );
          }
          settle();
        });
      } catch (e) {
        console.warn("Failed to spawn container-side kill process", e);
        settle();
      }
    });

    return containerCleanupPromise;
  };

  const stdout = new OutputWindow(opts.outputLimit);
  const stderr = new OutputWindow(opts.outputLimit);
  let stdinOpen = true;

  const exited = new Promise<number | null>((resolve) => {
    let settled = false;
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      stdinOpen = false;
      resolve(code);
    };

    child.on("error", (err: any) => {
      stderr.write(`Failed to spawn docker process: ${err.message}`);
      settle(127);
    });

    child.stdout.on("data", (data) => {
      stdout.write(data);
    });
    child.stderr.on("data", (data) => {
      stderr.write(data);
    });

    child.on("close", (code) => {
      stdout.end();
      stderr.end();
      if (killInitiated) {
        void containerCleanupPromise.then(() => settle(code));
      } else {
        settle(code);
      }
    });

    // Writing to stdin after the command exits fails with EPIPE; the exit is reported by "close".
    child.stdin.on("error", () => {
      stdinOpen = false;
    });
    if (child.stdin.writable) {
      child.stdin.write(command + "\n\0");
      if (!opts.keepStdinOpen) {
        stdinOpen = false;
        child.stdin.end();
      }
    } else {
      stdinOpen = false;
      const timer = setTimeout(() => {
        child.removeAllListeners("close");
        stderr.write("Docker process stdin not writable — timeout waiting for close.");
        settle(1);
      }, 1000);

      child.once("close", () => {
        clearTimeout(timer);
        void containerCleanupPromise.then(() => {
          stderr.write("Docker process stdin not writable — container may not be running.");
          settle(1);
        });
      });

      void killChild();
    }
  });

  return {
    spawned: true,
    exited,
    takeOutput: (maxTotalChars?: number) => {
      if (maxTotalChars === undefined) return { stdout: stdout.take(), stderr: stderr.take() };
      const [stdoutChars, stderrChars] = shareOutputBudget(stdout.pendingLength, stderr.pendingLength, maxTotalChars);
      return { stdout: stdout.take(stdoutChars), stderr: stderr.take(stderrChars) };
    },
    write: (input: string) => {
      if (!stdinOpen) return false;
      child.stdin.write(input);
      return true;
    },
    closeStdin: () => {
      if (!stdinOpen) return;
      stdinOpen = false;
      child.stdin.end();
    },
    kill: killChild,
  };
}

export async function runDockerProcess(
  command: string,
  signal?: AbortSignal,
  workDir?: string,
  outputLimit?: OutputLimit,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const run = startDockerProcess(command, { workDir, outputLimit });
  if (run.spawned && signal?.aborted) {
    await run.kill();
    return { stdout: "", stderr: "Docker process aborted", exitCode: 1 };
  }
  const onAbort = () => {
    void run.kill();
  };
  signal?.addEventListener("abort", onAbort);
  try {
    const exitCode = await run.exited;
    return { ...run.takeOutput(), exitCode };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function execCommand(
  command: string,
  signal?: AbortSignal,
  opts?: ExecOptions,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return execWithDefaults(runDockerProcess, command, signal, opts, EXEC_TIMEOUT_MS);
}
export function getWorkspaceRoot(): string {
  return getWorkspaceHostLocationOrThrow();
}
export function getWorkspaceHostLocation(): string {
  return getWorkspaceHostLocationOrThrow();
}
export function getGitDir(): string {
  return getWorkspaceHostLocationOrThrow() + "/snapshots/.git";
}
