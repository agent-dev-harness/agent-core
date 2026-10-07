import { assert, describe, it, vi, beforeEach } from "vitest";
import { runDockerProcess } from "../src/workspace/dockerRunner";
import * as cp from "child_process";
import * as crypto from "crypto";

vi.mock("child_process", () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0, error: undefined })),
}));

vi.mock("crypto", () => ({
  randomUUID: vi.fn(),
}));

describe("Docker Cleanup & Orphan Handling", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.CONTAINER_NAME = "test-container";
    process.env.WORKSPACE_HOST_LOCATION = "/workspace/applet_workspace";
    vi.mocked(cp.spawnSync).mockReturnValue({ status: 0, error: undefined } as any);
  });

  it("should spawn a container-side kill process on abort", async () => {
    const mockRunId = "1234abcd-1234-1234-1234-123456789012" as const;
    vi.mocked(crypto.randomUUID).mockReturnValue(mockRunId);

    const mockChild: any = {
      pid: 9999,
      kill: vi.fn(),
      on: vi.fn(),
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      stdin: { writable: true, write: vi.fn(), end: vi.fn(), on: vi.fn() },
      once: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    vi.mocked(cp.spawn).mockReturnValue(mockChild);

    const ac = new AbortController();
    const p = runDockerProcess("sleep 100", ac.signal);

    await new Promise((r) => setTimeout(r, 10));

    ac.abort();

    const calls = vi.mocked(cp.spawn).mock.calls;
    assert.ok(calls.length >= 2, "Expected at least 2 spawns (the run, and the kill)");

    const runCall = calls[0] as unknown as [string, string[], any];
    assert.strictEqual(runCall[0], "docker");
    assert.ok(runCall[1].includes("EXEC_RUN_ID=1234abcd-1234-1234-1234-123456789012"), "Expected run command to include RUN_ID env var");

    const killCall = calls[1] as any;
    assert.strictEqual(killCall[0], "docker");
    assert.strictEqual(killCall[1][1], "test-container");
    assert.strictEqual(killCall[1][2], "bash");
    assert.strictEqual(killCall[1][3], "-c");
    assert.deepStrictEqual(killCall[1].slice(5), ["kill-runs", "1234abcd-1234-1234-1234-123456789012"], "Expected kill exec to pass the RUN_ID as an argument, not string interpolation");
    assert.ok(!killCall[1][4].includes("1234abcd"), "Expected the RUN_ID not to be interpolated into the kill script");
    assert.ok(
      killCall[1][4].includes('grep -slE "$pattern" /proc/[0-9]*/environ'),
      "Expected kill command to grep for the RUN_IDs given as its arguments"
    );
  });

  function createMockChild(pid: number) {
    const listeners: Record<string, Array<(...args: any[]) => void>> = {};
    const child: any = {
      pid,
      kill: vi.fn(),
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      stdin: { writable: true, write: vi.fn(), end: vi.fn(), on: vi.fn() },
      on: vi.fn((event: string, cb: (...args: any[]) => void) => {
        (listeners[event] ||= []).push(cb);
        return child;
      }),
      once: vi.fn((event: string, cb: (...args: any[]) => void) => {
        (listeners[event] ||= []).push(cb);
        return child;
      }),
      removeAllListeners: vi.fn((event?: string) => {
        if (event) delete listeners[event];
        else for (const k of Object.keys(listeners)) delete listeners[k];
        return child;
      }),
      emit(event: string, ...args: any[]) {
        for (const cb of listeners[event] ?? []) cb(...args);
      },
    };
    return child;
  }

  it("still waits for container-side cleanup when the signal is already aborted before runDockerProcess is called", async () => {
    const mockRunId = "aaaa0000-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    vi.mocked(crypto.randomUUID).mockReturnValue(mockRunId as any);

    const mainChild = createMockChild(1111);
    const killProc = createMockChild(2222);
    let spawnCount = 0;
    vi.mocked(cp.spawn).mockImplementation(() => {
      spawnCount += 1;
      return spawnCount === 1 ? mainChild : killProc;
    });

    const ac = new AbortController();
    ac.abort();

    const p = runDockerProcess("sleep 100", ac.signal);

    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(spawnCount, 2, "Expected the main spawn plus the container-side kill spawn even for an already-aborted signal");

    let resolved = false;
    p.then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(resolved, false, "Should not resolve before container-side cleanup completes");

    killProc.emit("close", 0);

    const result = await p;
    assert.strictEqual(result.stderr, "Docker process aborted");
    assert.strictEqual(result.exitCode, 1);
  });

  it("still resolves (via the grace timeout) if the container-side kill process fails to spawn", async () => {
    const mockRunId = "bbbb1111-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    vi.mocked(crypto.randomUUID).mockReturnValue(mockRunId as any);

    const mainChild = createMockChild(3333);
    const killProc = createMockChild(4444);
    let spawnCount = 0;
    vi.mocked(cp.spawn).mockImplementation(() => {
      spawnCount += 1;
      return spawnCount === 1 ? mainChild : killProc;
    });

    const ac = new AbortController();
    const p = runDockerProcess("sleep 100", ac.signal);
    await new Promise((r) => setTimeout(r, 10));

    ac.abort();
    await new Promise((r) => setTimeout(r, 10));

    killProc.emit("error", new Error("ENOENT: docker not found"));

    mainChild.emit("close", null);

    const result = await p;
    assert.strictEqual(result.exitCode, null);
  });
});
