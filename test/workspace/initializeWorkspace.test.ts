import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GitSandbox } from '../../src/workspace/git';

describe('initializeWorkspace', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.WORKSPACE_HOST_LOCATION = '/tmp/ws';
  });

  function sandboxThat(init: () => Promise<void>): GitSandbox {
    return { initializeGitSandboxAsync: init } as unknown as GitSandbox;
  }

  it('can be retried after a failed attempt', async () => {
    const { initializeWorkspace, getGitSandbox } = await import('../../src/workspace/workspace');
    const failing = sandboxThat(() => Promise.reject(new Error('container not up yet')));
    const working = sandboxThat(() => Promise.resolve());

    await expect(initializeWorkspace({ createSandbox: () => failing })).rejects.toThrow(/container not up yet/);
    expect(() => getGitSandbox()).toThrow(/not initialized/);

    await initializeWorkspace({ createSandbox: () => working });
    expect(getGitSandbox()).toBe(working);
  });

  it('shares one attempt between concurrent calls', async () => {
    const { initializeWorkspace } = await import('../../src/workspace/workspace');
    const createSandbox = vi.fn(() => sandboxThat(() => new Promise((r) => setTimeout(r, 10))));

    await Promise.all([initializeWorkspace({ createSandbox }), initializeWorkspace({ createSandbox })]);

    expect(createSandbox).toHaveBeenCalledTimes(1);
  });
});
