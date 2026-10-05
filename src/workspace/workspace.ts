import * as docker from "./dockerRunner";
import { GitSandbox, ExecCommand } from "./git";

export type GitSandboxFactory = (
  workTree: string,
  gitDir: string,
  execCommand: ExecCommand
) => GitSandbox;

function defaultCreateSandbox(workTree: string, gitDir: string, execCommand: ExecCommand): GitSandbox {
  return new GitSandbox(workTree, gitDir, execCommand);
}

let _sandbox: GitSandbox | null = null;
let _initializing: Promise<void> | null = null;

// Concurrent calls share one attempt; a failed attempt is forgotten so the caller can retry
// (for example once the container is up).
export function initializeWorkspace(options?: {
  createSandbox?: GitSandboxFactory;
}): Promise<void> {
  if (_sandbox) return Promise.resolve();
  if (!_initializing) {
    _initializing = (async () => {
      const sandbox = (options?.createSandbox ?? defaultCreateSandbox)(
        docker.getWorkspaceRoot(),
        docker.getGitDir(),
        docker.execCommand
      );
      await sandbox.initializeGitSandboxAsync();
      _sandbox = sandbox;
    })().finally(() => {
      _initializing = null;
    });
  }
  return _initializing;
}

export function getGitSandbox(): GitSandbox {
  if (!_sandbox) {
    throw new Error(
      "GitSandbox is not initialized. Call initializeWorkspace() before getGitSandbox()."
    );
  }
  return _sandbox;
}

export function getExecCommand() {
  return docker.execCommand;
}

export function getStartCommand() {
  return docker.startDockerProcess;
}

export function getKillRuns() {
  return docker.killRunsInContainer;
}

export function getWorkspaceRoot(): string {
  return docker.getWorkspaceRoot();
}

export function getWorkspaceHostLocation(): string {
  return docker.getWorkspaceHostLocation();
}
