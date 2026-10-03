// Checks the Docker runner against a real, throwaway container (the test suite mocks child_process).
// Usage: npm run verify:docker   (needs a running Docker daemon)
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Needs bash and git.
const IMAGE = process.env.VERIFY_DOCKER_IMAGE ?? 'buildpack-deps:bookworm-scm';

function docker(...args: string[]): string {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed: ${result.stderr || result.error}`);
  }
  return result.stdout.trim();
}

const failures: string[] = [];
function check(name: string, ok: boolean, detail: unknown): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures.push(`${name}: ${JSON.stringify(detail)}`);
}

function processesRunning(containerName: string, command: string): string {
  const script =
    'for p in /proc/[0-9]*; do cmd=$(tr "\\0" " " < "$p/cmdline" 2>/dev/null); ' +
    `case "$cmd" in "${command} "*) echo "$p $cmd";; esac; done`;
  return docker('exec', containerName, 'bash', '-c', script);
}

// The runner caches its container and workspace settings per process, so a
// misconfiguration is probed in a fresh child process.
function probeInChild(env: Record<string, string>): string {
  const result = spawnSync('npx', ['tsx', fileURLToPath(import.meta.url), '--probe'], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return `${result.stdout}${result.stderr}`;
}

async function probe(): Promise<void> {
  const { execCommand } = await import('../../src/workspace/dockerRunner');
  try {
    const result = await execCommand('true');
    console.log(`RESOLVED ${JSON.stringify(result)}`);
  } catch (error) {
    console.log(`REJECTED ${(error as Error).message}`);
  }
}

async function main(): Promise<void> {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'verify-docker-')));
  fs.mkdirSync(path.join(workspace, 'sub'));
  const containerName = `agent-core-verify-${process.pid}`;

  docker('run', '-d', '--rm', '--name', containerName, '-v', `${workspace}:${workspace}`, IMAGE, 'sleep', 'infinity');
  try {
    process.env.CONTAINER_NAME = containerName;
    process.env.WORKSPACE_HOST_LOCATION = workspace;

    const { execCommand } = await import('../../src/workspace/dockerRunner');
    const { getExecCommand, initializeWorkspace, getGitSandbox } = await import('../../src/workspace');
    const { makeRunTerminalDockerHandler } = await import('../../src/execTool');

    check('getExecCommand selects the Docker runner by default', getExecCommand() === execCommand, null);

    const handler = makeRunTerminalDockerHandler();

    const root = await handler({ command: 'pwd' });
    check('runs in the workspace root by default', root.exitCode === 0 && root.stdout.trim() === workspace, root);

    const sub = await handler({ command: 'pwd', workingDir: 'sub' });
    check('resolves a relative workingDir', sub.exitCode === 0 && sub.stdout.trim() === path.join(workspace, 'sub'), sub);

    const traversal = await handler({ command: 'pwd', workingDir: '../..' });
    check('rejects a workingDir outside the workspace', traversal.exitCode === 1 && /traversal/i.test(traversal.stderr), traversal);

    const missing = await handler({ command: 'pwd', workingDir: 'does-not-exist' });
    check('reports a missing workingDir with exit 91', missing.exitCode === 91, missing);

    const wrote = await handler({ command: 'echo from-container > written.txt' });
    check(
      'writes land in the bind-mounted host workspace',
      wrote.exitCode === 0 && fs.readFileSync(path.join(workspace, 'written.txt'), 'utf8').trim() === 'from-container',
      wrote,
    );

    const mixed = await handler({ command: 'echo out; echo err >&2; exit 3' });
    check(
      'passes stdout, stderr and the exit code through',
      mixed.exitCode === 3 && mixed.stdout.trim() === 'out' && mixed.stderr.trim() === 'err',
      mixed,
    );

    const big = await handler({ command: "head -c 100000 /dev/zero | tr '\\0' a" });
    check(
      'truncates very large output',
      big.exitCode === 0 && big.stdout.length < 100000 && big.stdout.includes('Output truncated'),
      { exitCode: big.exitCode, length: big.stdout.length },
    );

    const concurrentStart = Date.now();
    const [first, second] = await Promise.all([
      handler({ command: 'sleep 2; echo first' }),
      handler({ command: 'sleep 2; echo second' }),
    ]);
    check(
      'runs commands concurrently without mixing their output',
      first.stdout.trim() === 'first' && second.stdout.trim() === 'second' && Date.now() - concurrentStart < 3900,
      { first, second, elapsedMs: Date.now() - concurrentStart },
    );

    const unmounted = probeInChild({ CONTAINER_NAME: containerName, WORKSPACE_HOST_LOCATION: '/not/mounted/here' });
    check(
      'refuses to run when the workspace path is not mounted in the container',
      unmounted.includes('REJECTED') && unmounted.includes('does not exist inside container'),
      unmounted,
    );

    const noContainer = probeInChild({ CONTAINER_NAME: `${containerName}-missing`, WORKSPACE_HOST_LOCATION: workspace });
    check(
      'refuses to run when the container does not exist',
      noContainer.includes('REJECTED') && noContainer.includes('Ensure the container is running'),
      noContainer,
    );

    docker('exec', '-d', containerName, 'sleep', '34');
    await new Promise((resolve) => setTimeout(resolve, 500));
    check('the leftover-process search finds a running process', processesRunning(containerName, 'sleep 34') !== '', null);

    const startedAt = Date.now();
    const timedOut = await execCommand('sleep 31; echo late', undefined, { timeoutMs: 2000 });
    check('kills a command at its deadline with exit 124', timedOut.exitCode === 124 && Date.now() - startedAt < 15000, timedOut);
    check('leaves no process behind after a deadline kill', processesRunning(containerName, 'sleep 31') === '', null);

    const controller = new AbortController();
    const aborted = execCommand('sleep 32 & sleep 33; wait', controller.signal);
    setTimeout(() => controller.abort(), 1000);
    await aborted;
    check(
      'abort kills the whole process tree in the container',
      processesRunning(containerName, 'sleep 32') === '' && processesRunning(containerName, 'sleep 33') === '',
      null,
    );

    fs.writeFileSync(path.join(workspace, 'notes.txt'), 'baseline\n');
    await initializeWorkspace();
    const sandbox = getGitSandbox();
    const baseline = await sandbox.getHeadShaAsync();
    check('initializeWorkspace creates the repo with a baseline commit, inside the container', /^[0-9a-f]{40}$/.test(baseline), baseline);
    check('keeps the git dir under snapshots/ in the workspace', fs.existsSync(path.join(workspace, 'snapshots', '.git', 'HEAD')), null);

    fs.writeFileSync(path.join(workspace, 'notes.txt'), 'changed\n');
    const diff = await sandbox.getGitDiffHead();
    check('getGitDiffHead shows a host-side edit', diff.includes('-baseline') && diff.includes('+changed'), diff);
    check('the snapshots dir never shows up in a diff', !diff.includes('snapshots/'), diff);

    const changed = await sandbox.commitAllChangesAsync('change notes');
    check('commitAllChangesAsync returns the new HEAD', changed !== baseline && changed === (await sandbox.getHeadShaAsync()), changed);

    fs.writeFileSync(path.join(workspace, 'notes.txt'), 'dirty\n');
    const dirtyRestore = await sandbox.restoreCheckpointAsync(baseline, 'restore').then(() => 'resolved', (e: Error) => e.message);
    check('refuses to restore a checkpoint over uncommitted changes', /uncommitted changes/.test(dirtyRestore), dirtyRestore);

    await sandbox.commitAllChangesAsync('dirty notes');
    fs.writeFileSync(path.join(workspace, 'extra.txt'), 'extra\n');
    await sandbox.commitAllChangesAsync('add extra');
    await sandbox.restoreCheckpointAsync(baseline, 'restore baseline');
    check(
      'restoreCheckpointAsync puts the files back as they were at the checkpoint',
      fs.readFileSync(path.join(workspace, 'notes.txt'), 'utf8') === 'baseline\n' && !fs.existsSync(path.join(workspace, 'extra.txt')),
      { notes: fs.readFileSync(path.join(workspace, 'notes.txt'), 'utf8'), extra: fs.existsSync(path.join(workspace, 'extra.txt')) },
    );

    const overlapping = await Promise.allSettled([sandbox.getHeadShaAsync(), sandbox.getHeadShaAsync()]);
    check(
      'refuses overlapping git operations',
      overlapping[0].status === 'fulfilled' && overlapping[1].status === 'rejected' && /busy/.test(String(overlapping[1].reason)),
      overlapping,
    );
  } finally {
    spawnSync('docker', ['rm', '-f', containerName]);
    fs.rmSync(workspace, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('\nAll Docker runner checks passed.');
}

(process.argv.includes('--probe') ? probe() : main()).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
