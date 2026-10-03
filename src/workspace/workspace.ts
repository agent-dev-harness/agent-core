import * as docker from "./dockerRunner";
import * as native from "./nativeRunner";
import { GitSandbox, ExecCommand } from "./git";

export type WorkspaceRunner = "docker" | "native";

let runnerKind: WorkspaceRunner = "docker";

function getRunner() {
  return runnerKind === "native" ? native : docker;
}

// Native runs agent commands on the host, so it is only ever chosen explicitly.
export function selectWorkspaceRunner(kind: WorkspaceRunner): void {
  if (_sandbox && kind !== runnerKind) {
    throw new Error(
      `The workspace is already initialized with the ${runnerKind} runner; it cannot switch to ${kind}.`
    );
  }
  runnerKind = kind;
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

export async function initializeWorkspace(options?: {
  runner?: WorkspaceRunner;
  createSandbox?: GitSandboxFactory;
}): Promise<void> {
  if (options?.runner) selectWorkspaceRunner(options.runner);
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
