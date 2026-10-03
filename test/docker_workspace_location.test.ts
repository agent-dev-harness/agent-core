import { assert, describe, it, vi, afterEach } from "vitest";

afterEach(() => {
  vi.resetModules();
  delete process.env.WORKSPACE_HOST_LOCATION;
});

describe("Docker workspace host location", () => {
  it("throws a clear config error instead of silently defaulting when unset", async () => {
    delete process.env.WORKSPACE_HOST_LOCATION;
    vi.resetModules();

    const { getWorkspaceHostLocation } = await import("../src/workspace/dockerRunner.js");

    assert.throws(
      () => getWorkspaceHostLocation(),
      /WORKSPACE_HOST_LOCATION environment variable is not set/
    );
  });

  it("respects an explicit workspace host override", async () => {
    process.env.WORKSPACE_HOST_LOCATION = "/custom/workspace";
    vi.resetModules();

    const { getWorkspaceHostLocation } = await import("../src/workspace/dockerRunner.js");

    assert.strictEqual(getWorkspaceHostLocation(), "/custom/workspace");
  });
});
