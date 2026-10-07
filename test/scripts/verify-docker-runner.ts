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
    const { makeTerminalDockerHandlers } = await import('../../src/execTool');

    check('getExecCommand returns the Docker runner', getExecCommand() === execCommand, null);

    fs.writeFileSync(path.join(workspace, 'notes.txt'), 'baseline\n');
    await initializeWorkspace();
    const terminal = makeTerminalDockerHandlers();
    const handler = terminal.run_terminal_docker;

    const root = await handler({ command: 'pwd' });
    check('runs in the workspace root by default', root.exitCode === 0 && root.stdout.trim() === workspace, root);

    const sub = await handler({ command: 'pwd', workingDir: 'sub' });
    check('resolves a relative workingDir', sub.exitCode === 0 && sub.stdout.trim() === path.join(workspace, 'sub'), sub);

    const traversal = await handler({ command: 'pwd', workingDir: '../..' });
    check('rejects a workingDir outside the workspace', traversal.exitCode === 1 && /traversal/i.test(traversal.stderr), traversal);

    fs.symlinkSync('/etc', path.join(workspace, 'escape-link'));
    const viaSymlink = await handler({ command: 'pwd -P', workingDir: 'escape-link' });
    check('rejects a workingDir that leaves the workspace through a symlink', viaSymlink.exitCode === 1 && /traversal/i.test(viaSymlink.stderr), viaSymlink);

    const absolute = await handler({ command: 'pwd', workingDir: path.join(workspace, 'sub') });
    check('accepts an absolute workingDir inside the workspace', absolute.exitCode === 0 && absolute.stdout.trim() === path.join(workspace, 'sub'), absolute);

    fs.symlinkSync(path.join(workspace, 'sub'), path.join(workspace, 'inside-link'));
    const insideLink = await handler({ command: 'pwd -P', workingDir: 'inside-link' });
    check('allows a symlink that stays inside the workspace', insideLink.exitCode === 0 && insideLink.stdout.trim() === path.join(workspace, 'sub'), insideLink);

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

    const bothStreams = await handler({ command: "head -c 60000 /dev/zero | tr '\\0' a; head -c 60000 /dev/zero | tr '\\0' b >&2" });
    check(
      'stdout and stderr together stay within the tool output budget',
      bothStreams.stdout.length + bothStreams.stderr.length <= 40_000 && bothStreams.stdout.includes('Output truncated') && bothStreams.stderr.includes('Output truncated'),
      { stdout: bothStreams.stdout.length, stderr: bothStreams.stderr.length },
    );

    const endless = await handler({ command: 'yes | head -c 700M', initialWaitSeconds: 300 });
    check(
      'survives output larger than the maximum string length',
      endless.exitCode === 0 && endless.stdout.includes('Output truncated'),
      { exitCode: endless.exitCode, length: endless.stdout.length },
    );

    const euros = await handler({ command: `perl -CS -e 'print "\\x{20AC}" x 30000'` });
    check('keeps multibyte characters split across pipe chunks', euros.stdout === '€'.repeat(30000), euros.stdout.length);

    const script = await handler({ command: "cat <<'EOF'\nhello $HOME\nEOF\nfor i in 1 2; do\n  echo $i\ndone\nexit 7" });
    check('keeps heredocs, multi-line syntax and the exit code', script.stdout === 'hello $HOME\n1\n2\n' && script.exitCode === 7, script);

    const bigScript = await handler({ command: `: '${'x'.repeat(1_000_000)}'\necho big-ok` });
    check('runs scripts larger than the kernel limit for a single argument', bigScript.stdout === 'big-ok\n', bigScript.stderr);

    const counted = await handler({ command: 'seq 1 200000' });
    check('truncation keeps the end of the output', counted.stdout.endsWith('200000\n') && counted.stdout.length <= 40_200, counted.stdout.length);

    const stdinReader = await handler({ command: 'cat\necho line2-ran' });
    check('a command reading stdin does not consume the next line', stdinReader.stdout === 'line2-ran\n', stdinReader);

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

    await execCommand('env -i /bin/sleep 35 & (exec -c sleep 36) & sleep 37', undefined, { timeoutMs: 2000 });
    check(
      'a deadline kill also reaches children that cleared their environment',
      processesRunning(containerName, '/bin/sleep 35') === '' && processesRunning(containerName, 'sleep 36') === '',
      null,
    );

    await execCommand('( env -i setsid sleep 38 & ); sleep 39', undefined, { timeoutMs: 2000 });
    check(
      'a deadline kill also reaches a process that cleared its environment and detached',
      processesRunning(containerName, 'sleep 38') === '',
      null,
    );

    const callerOnly = await execCommand('sleep 0.2 && echo fine', AbortSignal.timeout(10_000));
    check("a caller's signal alone is the only deadline", callerOnly.exitCode === 0 && callerOnly.stdout === 'fine\n', callerOnly);

    const both = await execCommand('sleep 10 && echo done', AbortSignal.timeout(30_000), { timeoutMs: 1200 });
    check("a caller's signal combines with timeoutMs", both.exitCode === 124 && both.stderr.includes('timed out after 1s'), both);

    const controller = new AbortController();
    const aborted = execCommand('sleep 32 & sleep 33; wait', controller.signal);
    setTimeout(() => controller.abort(), 1000);
    await aborted;
    check(
      'abort kills the whole process tree in the container',
      processesRunning(containerName, 'sleep 32') === '' && processesRunning(containerName, 'sleep 33') === '',
      null,
    );

    const turn = new AbortController();
    const turnAborted = handler({ command: 'sleep 40', initialWaitSeconds: 120 }, { abortSignal: turn.signal });
    setTimeout(() => turn.abort(), 1000);
    const turnStartedAt = Date.now();
    await turnAborted;
    check(
      "the handler kills its command when the turn's abort signal fires",
      Date.now() - turnStartedAt < 10000 && processesRunning(containerName, 'sleep 40') === '',
      { elapsedMs: Date.now() - turnStartedAt },
    );

    const slow = await handler({ command: 'echo start; sleep 3; echo end', initialWaitSeconds: 1 });
    check(
      'a command still running after its initial wait keeps running and returns a shellId',
      slow.status === 'running' && slow.exitCode === null && slow.stdout === 'start\n' && typeof slow.shellId === 'string' &&
        processesRunning(containerName, 'sleep 3') !== '',
      slow,
    );
    const slowDone = await terminal.read_terminal_docker({ shellId: slow.shellId, waitSeconds: 30 });
    check(
      'read_terminal_docker returns the rest of the output and the exit code',
      slowDone.status === 'exited' && slowDone.exitCode === 0 && slowDone.stdout === 'end\n',
      slowDone,
    );

    const interactive = await handler({ command: 'read -r line; echo "got:$line"', mode: 'async' });
    const answered = await terminal.write_terminal_docker({ shellId: interactive.shellId, input: 'hello\n', waitSeconds: 10 });
    check(
      'an async command takes input through write_terminal_docker',
      answered.status === 'exited' && answered.exitCode === 0 && answered.stdout === 'got:hello\n',
      answered,
    );

    const toStop = await handler({ command: 'sleep 41 & sleep 42', initialWaitSeconds: 0 });
    const stopped = await terminal.stop_terminal_docker({ shellId: toStop.shellId });
    check(
      'stop_terminal_docker kills a background command and its children',
      stopped.status === 'exited' && processesRunning(containerName, 'sleep 41') === '' && processesRunning(containerName, 'sleep 42') === '',
      stopped,
    );

    const session = new AbortController();
    const sessionTerminal = makeTerminalDockerHandlers(session.signal);
    await sessionTerminal.run_terminal_docker({ command: 'sleep 43', mode: 'async' });
    await sessionTerminal.run_terminal_docker({ command: 'sleep 44', initialWaitSeconds: 0 });
    const leftBehind = await sessionTerminal.run_terminal_docker({ command: 'sleep 45 & nohup sleep 46 >/dev/null 2>&1 & echo started' });
    const leftRunning = processesRunning(containerName, 'sleep 45') !== '' && processesRunning(containerName, 'sleep 46') !== '';
    session.abort();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    check(
      'ending the session kills its background commands',
      processesRunning(containerName, 'sleep 43') === '' && processesRunning(containerName, 'sleep 44') === '',
      null,
    );
    check(
      'ending the session kills what a finished command left running with &',
      leftBehind.exitCode === 0 && leftRunning && processesRunning(containerName, 'sleep 45') === '' && processesRunning(containerName, 'sleep 46') === '',
      { leftBehind, leftRunning },
    );

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
    // The container runs as root, so a non-root host user (as in CI) can't delete what it wrote.
    spawnSync('docker', ['exec', containerName, 'find', workspace, '-mindepth', '1', '-delete']);
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
