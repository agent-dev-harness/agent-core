import * as docker from "./dockerRunner";
import * as native from "./nativeRunner";
import { GitSandbox, ExecCommand } from "./git";

function isAIStudio(): boolean {
  return process.env.AI_STUDIO === "true" || process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}

function getRunner() {
  return isAIStudio() ? native : docker;
}

export type GitSandboxFactory = (
  workTree: string,
  gitDir: string,
  execCommand: ExecCommand
) => GitSandbox;

function defaultCreateSandbox(workTree: string, gitDir: string, execCommand: ExecCommand): GitSandbox {
  return new GitSandbox(workTree, gitDir, execCommand);
}

let _sandbox: GitSandbox | null = null;

export async function initializeWorkspace(options?: { createSandbox?: GitSandboxFactory }): Promise<void> {
  if (_sandbox) return;
  const runner = getRunner();
  _sandbox = (options?.createSandbox ?? defaultCreateSandbox)(
    runner.getWorkspaceRoot(),
    runner.getGitDir(),
    runner.execCommand
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
  return getRunner().execCommand;
}

export function getWorkspaceRoot(): string {
  return getRunner().getWorkspaceRoot();
}

export function getWorkspaceHostLocation(): string {
  return getRunner().getWorkspaceHostLocation();
}
