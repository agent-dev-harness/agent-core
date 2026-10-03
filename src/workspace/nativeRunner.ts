import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { killProcessGroup } from "./processGroup";
import { ExecOptions, OutputCollector, OutputLimit, execWithDefaults, prependWorkDir, resolveWorkDir } from "./execHelpers";

const FIXED_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "app-"));

const FIXED_PATH = "/usr/local/bin:/usr/bin:/bin";

fs.mkdirSync(FIXED_WORKSPACE_ROOT, { recursive: true });

const EXEC_TIMEOUT_MS = 60_000;

export async function runNativeProcess(
  command: string,
  signal?: AbortSignal,
  workDir?: string,
  outputLimit?: OutputLimit,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const workspaceRoot = getWorkspaceRoot();

    if (workDir !== undefined) {
      const resolved = resolveWorkDir(workDir, workspaceRoot);
      if (!resolved.ok) {
        resolve({ stdout: "", stderr: resolved.error, exitCode: 1 });
        return;
      }
      command = prependWorkDir(command, resolved.dir, workspaceRoot);
    }

    const child = spawn("bash", ["-s"], {
      cwd: getWorkspaceRoot(),
      env: { PATH: FIXED_PATH },
      detached: true,
    });

    const killChild = () => killProcessGroup(child);

    const onAbort = () => killChild();
    if (signal) {
      signal.addEventListener("abort", onAbort);
      if (signal.aborted) {
        killChild();
        const timer = setTimeout(() => {
          child.removeAllListeners("close");
          resolve({ stdout: "", stderr: "Native process aborted", exitCode: 1 });
        }, 1000);
        child.once("close", () => {
          clearTimeout(timer);
          resolve({ stdout: "", stderr: "Native process aborted", exitCode: 1 });
        });
        return;
      }
    }

    child.on("error", (err: any) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({
        stdout: "",
        stderr: `Failed to spawn native process: ${err.message}`,
        exitCode: 127,
      });
    });

    const stdout = new OutputCollector(outputLimit);
    const stderr = new OutputCollector(outputLimit);

    child.stdout.on("data", (data) => {
      stdout.write(data);
    });
    child.stderr.on("data", (data) => {
      stderr.write(data);
    });

    child.on("close", (code) => {
       if (signal) signal.removeEventListener("abort", onAbort);
       resolve({ stdout: stdout.finish(), stderr: stderr.finish(), exitCode: code });
     });

    if (child.stdin.writable) {
      child.stdin.write(command + "\n");
      child.stdin.end();
    } else {
      if (signal) signal.removeEventListener("abort", onAbort);
      killChild();

      const timer = setTimeout(() => {
        child.removeAllListeners("close");
        resolve({
          stdout: "",
          stderr: "Native process stdin not writable — timeout waiting for close.",
          exitCode: 1,
        });
      }, 1000);

      child.once("close", () => {
        clearTimeout(timer);
        resolve({
          stdout: "",
          stderr: "Native process stdin not writable — process failed to start.",
          exitCode: 1,
        });
      });
    }
  });
}

export async function execCommand(
  command: string,
  signal?: AbortSignal,
  opts?: ExecOptions,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return execWithDefaults(runNativeProcess, command, signal, opts, EXEC_TIMEOUT_MS);
}

export function getWorkspaceRoot(): string {
  return FIXED_WORKSPACE_ROOT;
}

export function getWorkspaceHostLocation(): string {
  return FIXED_WORKSPACE_ROOT;
}

export function getGitDir(): string {
  return FIXED_WORKSPACE_ROOT + "/snapshots/.git";
}
