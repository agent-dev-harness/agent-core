import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

async function freshModules() {
  vi.resetModules();
  const workspace = await import('../../src/workspace/workspace');
  const docker = await import('../../src/workspace/dockerRunner');
  const native = await import('../../src/workspace/nativeRunner');
  return { workspace, docker, native };
}

describe('workspace runner selection', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('defaults to the Docker runner even when NODE_ENV=test, VITEST=true and AI_STUDIO=true are set', async () => {
    const saved = { NODE_ENV: process.env.NODE_ENV, VITEST: process.env.VITEST, AI_STUDIO: process.env.AI_STUDIO };
    process.env.NODE_ENV = 'test';
    process.env.VITEST = 'true';
    process.env.AI_STUDIO = 'true';
    try {
      const { workspace, docker } = await freshModules();
      expect(workspace.getExecCommand()).toBe(docker.execCommand);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('uses the native runner only when selected explicitly', async () => {
    const { workspace, native } = await freshModules();
    workspace.selectWorkspaceRunner('native');
    expect(workspace.getExecCommand()).toBe(native.execCommand);
    expect(workspace.getWorkspaceRoot()).toBe(native.getWorkspaceRoot());
  });

  it('passes only a fixed PATH to native commands, not the caller environment', async () => {
    process.env.AGENT_CORE_SECRET_PROBE = 'leaked';
    try {
      const { native } = await freshModules();
      const result = await native.execCommand('echo "[$AGENT_CORE_SECRET_PROBE]"; echo "$PATH"');
      expect(result.stdout.split('\n')[0]).toBe('[]');
      expect(result.stdout.split('\n')[1]).toBe('/usr/local/bin:/usr/bin:/bin');
    } finally {
      delete process.env.AGENT_CORE_SECRET_PROBE;
    }
  });

  it('initializeWorkspace({ runner }) selects the runner, and it cannot change afterwards', async () => {
    const { workspace, native } = await freshModules();
    await workspace.initializeWorkspace({ runner: 'native' });
    expect(workspace.getExecCommand()).toBe(native.execCommand);
    expect(() => workspace.selectWorkspaceRunner('docker')).toThrow(/already initialized with the native runner/);
    expect(() => workspace.selectWorkspaceRunner('native')).not.toThrow();
    fs.rmSync(path.join(native.getWorkspaceRoot(), 'snapshots'), { recursive: true, force: true });
  });
});
