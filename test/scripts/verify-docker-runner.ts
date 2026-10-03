// Checks the Docker runner against a real, throwaway container (the test suite mocks child_process).
// Usage: npm run verify:docker   (needs a running Docker daemon)
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const IMAGE = process.env.VERIFY_DOCKER_IMAGE ?? 'debian:bookworm-slim';

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

async function main(): Promise<void> {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'verify-docker-')));
  fs.mkdirSync(path.join(workspace, 'sub'));
  const containerName = `agent-core-verify-${process.pid}`;

  docker('run', '-d', '--rm', '--name', containerName, '-v', `${workspace}:${workspace}`, IMAGE, 'sleep', 'infinity');
  try {
    process.env.CONTAINER_NAME = containerName;
    process.env.WORKSPACE_HOST_LOCATION = workspace;
    delete process.env.AI_STUDIO;
    delete process.env.NODE_ENV;
    delete process.env.VITEST;

    const { execCommand } = await import('../../src/workspace/dockerRunner');
    const { getExecCommand } = await import('../../src/workspace');
    const { makeRunTerminalDockerHandler } = await import('../../src/execTool');

    check('getExecCommand selects the Docker runner', getExecCommand() === execCommand, null);

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

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
