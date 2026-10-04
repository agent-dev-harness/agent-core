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

export async function initializeWorkspace(options?: {
  createSandbox?: GitSandboxFactory;
}): Promise<void> {
  if (_sandbox) return;
  _sandbox = (options?.createSandbox ?? defaultCreateSandbox)(
    docker.getWorkspaceRoot(),
    docker.getGitDir(),
    docker.execCommand
  );
  await _sandbox.initializeGitSandboxAsync();
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

export function getWorkspaceRoot(): string {
  return docker.getWorkspaceRoot();
}

export function getWorkspaceHostLocation(): string {
  return docker.getWorkspaceHostLocation();
}
