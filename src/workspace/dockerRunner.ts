import { spawn, spawnSync } from "child_process";
import * as crypto from "crypto";
import { killProcessGroup } from "./processGroup";
import { ExecOptions, execWithDefaults, prependWorkDir, resolveWorkDir } from "./execHelpers";

// No default: a guessed path would hide a misconfigured mount instead of failing.
let WORKSPACE_HOST_LOCATION = "";

function getWorkspaceHostLocationOrThrow(): string {
  if (!WORKSPACE_HOST_LOCATION) {
    WORKSPACE_HOST_LOCATION = process.env.WORKSPACE_HOST_LOCATION || "";
    if (!WORKSPACE_HOST_LOCATION) {
      throw new Error(
        "WORKSPACE_HOST_LOCATION environment variable is not set. It must match the " +
          "path docker-compose.yml mounted the workspace at (see docker compose up).",
      );
    }
  }
  return WORKSPACE_HOST_LOCATION;
}

const EXEC_TIMEOUT_MS = 60_000;

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

export async function runDockerProcess(
  command: string,
  signal?: AbortSignal,
  workDir?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const workspaceRoot = getWorkspaceHostLocationOrThrow();

    if (workDir !== undefined) {
      const resolved = resolveWorkDir(workDir, workspaceRoot);
      if (!resolved.ok) {
        resolve({ stdout: "", stderr: resolved.error, exitCode: 1 });
        return;
      }
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
      "-s",
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
          // there by run marker. The kill shell carries the marker too and skips itself ($$).
          const killCmd = `for pid in $(grep -sl "EXEC_RUN_ID=$EXEC_RUN_ID" /proc/[0-9]*/environ | cut -d/ -f3); do [ "$pid" = "$$" ] && continue; kill -9 "$pid" || echo "kill-failed pid=$pid" >&2; done`;
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

    const onAbort = () => {
      void killChild();
    };
    if (signal) {
      signal.addEventListener("abort", onAbort);
      if (signal.aborted) {
        void killChild().then(() => {
          resolve({ stdout: "", stderr: "Docker process aborted", exitCode: 1 });
        });
        return;
      }
    }

    child.on("error", (err: any) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({
        stdout: "",
        stderr: `Failed to spawn docker process: ${err.message}`,
        exitCode: 127,
      });
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (killInitiated) {
        void containerCleanupPromise.then(() => {
          resolve({ stdout, stderr, exitCode: code });
        });
      } else {
        resolve({ stdout, stderr, exitCode: code });
      }
    });
    if (child.stdin.writable) {
      child.stdin.write(command + "\n");
      child.stdin.end();
    } else {
      if (signal) signal.removeEventListener("abort", onAbort);

      const timer = setTimeout(() => {
        child.removeAllListeners("close");
        resolve({
          stdout: "",
          stderr: "Docker process stdin not writable — timeout waiting for close.",
          exitCode: 1,
        });
      }, 1000);

      child.once("close", () => {
        clearTimeout(timer);
        void containerCleanupPromise.then(() => {
          resolve({
            stdout: "",
            stderr: "Docker process stdin not writable — container may not be running.",
            exitCode: 1,
          });
        });
      });

      void killChild();
    }
  });
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
