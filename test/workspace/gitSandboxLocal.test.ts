import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitSandbox } from '../../src/workspace/git';

// Runs GitSandbox's commands in a local bash, as the container would, so quoting is tested for real.
async function localExec(command: string) {
  const result = spawnSync('bash', ['--norc', '-c', command], { encoding: 'utf8' });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function workspaceWithSpace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'my workspace '));
  dirs.push(dir);
  return dir;
}

describe('GitSandbox paths', () => {
  it("works when the workspace path contains a space and a quote", async () => {
    const root = path.join(workspaceWithSpace(), "it's here");
    const sandbox = new GitSandbox(root, `${root}/snapshots/.git`, localExec);
    await sandbox.initializeGitSandboxAsync();

    fs.writeFileSync(path.join(root, 'a.txt'), 'hi\n');
    const sha = await sandbox.commitAllChangesAsync('first');

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('names the cause when the snapshots directory has been deleted', async () => {
    const root = workspaceWithSpace();
    const sandbox = new GitSandbox(root, `${root}/snapshots/.git`, localExec);
    await sandbox.initializeGitSandboxAsync();
    fs.rmSync(path.join(root, 'snapshots'), { recursive: true, force: true });

    await expect(sandbox.getHeadShaAsync()).rejects.toThrow(/checkpoint repository .* is gone.*snapshots\//s);
  });
});
