import { assert, describe, it, vi, afterEach } from "vitest";

const ENV_KEYS = ["AI_STUDIO", "NODE_ENV", "VITEST", "WORKSPACE_HOST_LOCATION"] as const;
const savedEnv: Record<string, string | undefined> = {};

afterEach(() => {
  vi.resetModules();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function clearRunnerEnv() {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}

describe("dockerRunner path resolution off WORKSPACE_HOST_LOCATION", () => {
  it("throws a clear config error when WORKSPACE_HOST_LOCATION is unset, instead of silently defaulting", async () => {
    clearRunnerEnv();
    vi.resetModules();

    const docker = await import("../src/workspace/dockerRunner.js");

    assert.throws(
      () => docker.getWorkspaceRoot(),
      /WORKSPACE_HOST_LOCATION environment variable is not set/
    );
    assert.throws(
      () => docker.getGitDir(),
      /WORKSPACE_HOST_LOCATION environment variable is not set/
    );
  });

  it("resolves getWorkspaceRoot()/getGitDir() off a custom host-mirrored WORKSPACE_HOST_LOCATION, not a fixed in-container path", async () => {
    clearRunnerEnv();
    process.env.WORKSPACE_HOST_LOCATION = "/custom/host/workspace";
    vi.resetModules();

    const docker = await import("../src/workspace/dockerRunner.js");

    assert.strictEqual(docker.getWorkspaceRoot(), "/custom/host/workspace");
    assert.strictEqual(docker.getWorkspaceHostLocation(), "/custom/host/workspace");
    assert.strictEqual(docker.getGitDir(), "/custom/host/workspace/snapshots/.git");
  });

  it("holds the host-mirroring invariant: getWorkspaceRoot() === getWorkspaceHostLocation()", async () => {
    clearRunnerEnv();
    process.env.WORKSPACE_HOST_LOCATION = "/another/custom/path";
    vi.resetModules();

    const docker = await import("../src/workspace/dockerRunner.js");

    assert.strictEqual(docker.getWorkspaceRoot(), docker.getWorkspaceHostLocation());
  });
});

describe("getRunner() Docker branch delegation", () => {
  it("workspace.ts delegates getWorkspaceRoot()/getWorkspaceHostLocation() to the Docker runner outside AI Studio mode", async () => {
    clearRunnerEnv();
    process.env.WORKSPACE_HOST_LOCATION = "/delegated/path";
    vi.resetModules();

    const workspace = await import("../src/workspace/workspace.js");

    assert.strictEqual(workspace.getWorkspaceRoot(), "/delegated/path");
    assert.strictEqual(workspace.getWorkspaceHostLocation(), "/delegated/path");
  });
});
