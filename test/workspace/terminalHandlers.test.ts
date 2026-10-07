import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DockerRun, StartOptions } from '../../src/workspace/dockerRunner';

interface FakeRun extends DockerRun {
  emit(stdout: string, stderr?: string): void;
  exit(code: number | null): void;
  readonly writes: string[];
  readonly killed: boolean;
  readonly stdinClosed: boolean;
}

const started: { command: string; opts: StartOptions; run: FakeRun }[] = [];
const sweeps: string[][] = [];

function fakeRun(keepStdinOpen: boolean, runId: string): FakeRun {
  let out = '';
  let err = '';
  let resolveExit!: (code: number | null) => void;
  const exited = new Promise<number | null>((resolve) => {
    resolveExit = resolve;
  });
  const state = { killed: false, stdinOpen: keepStdinOpen, done: false };
  const writes: string[] = [];
  const exit = (code: number | null) => {
    if (state.done) return;
    state.done = true;
    state.stdinOpen = false;
    resolveExit(code);
  };
  return {
    spawned: true,
    runId,
    exited,
    takeOutput: () => {
      const taken = { stdout: out, stderr: err };
      out = '';
      err = '';
      return taken;
    },
    write: (input) => {
      if (!state.stdinOpen) return false;
      writes.push(input);
      return true;
    },
    closeStdin: () => {
      state.stdinOpen = false;
    },
    kill: async () => {
      state.killed = true;
      exit(null);
    },
    emit: (stdout, stderr = '') => {
      out += stdout;
      err += stderr;
    },
    exit,
    writes,
    get killed() {
      return state.killed;
    },
    get stdinClosed() {
      return !state.stdinOpen;
    },
  };
}

const workspaceState = vi.hoisted(() => ({ initialized: true }));

vi.mock('../../src/workspace/workspace', () => ({
  isWorkspaceInitialized: () => workspaceState.initialized,
  getWorkspaceRoot: () => '/ws',
  getStartCommand: () => (command: string, opts: StartOptions = {}) => {
    const run = fakeRun(opts.keepStdinOpen === true, `run-${started.length + 1}`);
    started.push({ command, opts, run });
    return run;
  },
  getKillRuns: () => async (runIds: readonly string[]) => {
    sweeps.push([...runIds]);
  },
}));

const { makeTerminalDockerHandlers, MAX_UNREAD_EXITED_TERMINALS } = await import('../../src/execTool');

function lastRun(): FakeRun {
  const entry = started[started.length - 1];
  if (!entry) throw new Error('no command was started');
  return entry.run;
}

describe('makeTerminalDockerHandlers', () => {
  it('throws until the workspace is initialized', () => {
    workspaceState.initialized = false;
    try {
      expect(() => makeTerminalDockerHandlers()).toThrow(/Call initializeWorkspace\(\) first/);
    } finally {
      workspaceState.initialized = true;
    }
    expect(() => makeTerminalDockerHandlers()).not.toThrow();
  });
});

describe('run_terminal_docker', () => {
  beforeEach(() => {
    started.length = 0;
    sweeps.length = 0;
  });

  it('returns the plain result when the command finishes within the initial wait', async () => {
    const terminal = makeTerminalDockerHandlers();
    const pending = terminal.run_terminal_docker({ command: 'echo hi' });
    lastRun().emit('hi\n');
    lastRun().exit(0);
    expect(await pending).toEqual({ stdout: 'hi\n', stderr: '', exitCode: 0 });
    expect(started[0]?.opts.keepStdinOpen).toBe(false);
  });

  it('leaves a command running past the initial wait in the background instead of killing it', async () => {
    const terminal = makeTerminalDockerHandlers();
    const pending = terminal.run_terminal_docker({ command: 'npm run build', initialWaitSeconds: 0 });
    lastRun().emit('compiling...\n');
    const result = await pending;

    expect(result).toMatchObject({ stdout: 'compiling...\n', exitCode: null, status: 'running', shellId: 'shell-1' });
    expect(result.note).toContain('read_terminal_docker');
    expect(lastRun().killed).toBe(false);
  });

  it('reports only new output on each read, then the exit code, then forgets the shellId', async () => {
    const terminal = makeTerminalDockerHandlers();
    expectRunning(await terminal.run_terminal_docker({ command: 'build', initialWaitSeconds: 0 }));
    const run = lastRun();

    run.emit('step 2\n');
    expect(await terminal.read_terminal_docker({ shellId: 'shell-1', waitSeconds: 0 })).toMatchObject({
      stdout: 'step 2\n',
      status: 'running',
      exitCode: null,
    });

    const reading = terminal.read_terminal_docker({ shellId: 'shell-1', waitSeconds: 600 });
    run.emit('done\n');
    run.exit(0);
    expect(await reading).toMatchObject({ stdout: 'done\n', status: 'exited', exitCode: 0 });

    const again = await terminal.read_terminal_docker({ shellId: 'shell-1' });
    expect(again.exitCode).toBe(2);
    expect(again.stderr).toContain("no terminal with shellId 'shell-1'");
  });

  it('starts an async command with stdin open and returns at once', async () => {
    const terminal = makeTerminalDockerHandlers();
    const result = await terminal.run_terminal_docker({ command: 'python3 -i', mode: 'async' });

    expect(result).toMatchObject({ status: 'running', shellId: 'shell-1' });
    expect(started[0]?.opts.keepStdinOpen).toBe(true);

    await terminal.write_terminal_docker({ shellId: 'shell-1', input: 'print(1)\n', waitSeconds: 0 });
    expect(lastRun().writes).toEqual(['print(1)\n']);

    await terminal.write_terminal_docker({ shellId: 'shell-1', endInput: true, waitSeconds: 0 });
    expect(lastRun().stdinClosed).toBe(true);
  });

  it('says so when input is sent to a command whose stdin is closed', async () => {
    const terminal = makeTerminalDockerHandlers();
    await terminal.run_terminal_docker({ command: 'sleep 100', initialWaitSeconds: 0 });

    const result = await terminal.write_terminal_docker({ shellId: 'shell-1', input: 'y\n', waitSeconds: 0 });
    expect(result.note).toContain('Input was not sent');
    expect(lastRun().writes).toEqual([]);
  });

  it('stop kills the command and reports its exit', async () => {
    const terminal = makeTerminalDockerHandlers();
    await terminal.run_terminal_docker({ command: 'serve', mode: 'async' });

    const result = await terminal.stop_terminal_docker({ shellId: 'shell-1' });
    expect(lastRun().killed).toBe(true);
    expect(result).toMatchObject({ status: 'exited', exitCode: null, note: 'Stopped.' });
    expect((await terminal.list_terminal_docker()).terminals).toEqual([]);
  });

  it('forgets the oldest finished commands once more than the cap are unread', async () => {
    const terminal = makeTerminalDockerHandlers();
    for (let i = 0; i <= MAX_UNREAD_EXITED_TERMINALS; i++) {
      await terminal.run_terminal_docker({ command: `job ${i}`, mode: 'async' });
      lastRun().exit(0);
    }
    await new Promise((r) => setTimeout(r, 0));

    const { terminals } = await terminal.list_terminal_docker();
    expect(terminals).toHaveLength(MAX_UNREAD_EXITED_TERMINALS);
    expect(terminals[0]?.shellId).toBe('shell-2');
    expect((await terminal.read_terminal_docker({ shellId: 'shell-1' })).stderr).toContain('no terminal');
  });

  it('lists running commands', async () => {
    const terminal = makeTerminalDockerHandlers();
    await terminal.run_terminal_docker({ command: 'serve', mode: 'async' });

    const { terminals } = await terminal.list_terminal_docker();
    expect(terminals).toEqual([{ shellId: 'shell-1', command: 'serve', status: 'running', exitCode: null, runningSeconds: 0 }]);
  });

  it('kills every background command when the session signal fires', async () => {
    const session = new AbortController();
    const terminal = makeTerminalDockerHandlers(session.signal);
    await terminal.run_terminal_docker({ command: 'a', mode: 'async' });
    await terminal.run_terminal_docker({ command: 'b', initialWaitSeconds: 0 });

    session.abort();
    await new Promise((r) => setTimeout(r, 0));
    expect(started.map((s) => s.run.killed)).toEqual([true, true]);
  });

  it('also kills what finished commands left running when the session signal fires', async () => {
    const session = new AbortController();
    const terminal = makeTerminalDockerHandlers(session.signal);
    const finished = terminal.run_terminal_docker({ command: 'server & echo started' });
    lastRun().exit(0);
    await finished;
    await terminal.run_terminal_docker({ command: 'serve', mode: 'async' });

    session.abort();
    await new Promise((r) => setTimeout(r, 0));
    expect(sweeps).toEqual([['run-1']]);
    expect(started[1]?.run.killed).toBe(true);
  });

  it('counts runningSeconds from when the command started, not from when it went to the background', async () => {
    vi.useFakeTimers();
    try {
      const terminal = makeTerminalDockerHandlers();
      const pending = terminal.run_terminal_docker({ command: 'build', initialWaitSeconds: 5 });
      await vi.advanceTimersByTimeAsync(5000);
      expectRunning(await pending);

      expect((await terminal.list_terminal_docker()).terminals[0]?.runningSeconds).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says a shellId must be a string when given another type', async () => {
    const terminal = makeTerminalDockerHandlers();
    const result = await terminal.read_terminal_docker({ shellId: 3 });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(`'shellId' must be a string like "shell-1"`);
    expect(result.stderr).toContain('number 3');
  });

  it("kills the command when the turn's abort signal fires during the initial wait", async () => {
    const terminal = makeTerminalDockerHandlers();
    const turn = new AbortController();
    const pending = terminal.run_terminal_docker({ command: 'sleep 100' }, { abortSignal: turn.signal });
    turn.abort();

    expect(await pending).toMatchObject({ exitCode: null });
    expect(lastRun().killed).toBe(true);
  });

  it('does not kill a background command when a later turn is aborted', async () => {
    const terminal = makeTerminalDockerHandlers();
    const turn = new AbortController();
    await terminal.run_terminal_docker({ command: 'serve', initialWaitSeconds: 0 }, { abortSignal: turn.signal });
    turn.abort();

    expect(lastRun().killed).toBe(false);
  });

  it('rejects a call with no command instead of running an empty script', async () => {
    const terminal = makeTerminalDockerHandlers();
    const result = await terminal.run_terminal_docker({ cmd: 'exit 3' });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("missing required argument 'command'");
    expect(result.stderr).toContain('cmd');
    expect(started).toHaveLength(0);
  });

  it('rejects a workingDir outside the workspace before starting anything', async () => {
    const terminal = makeTerminalDockerHandlers();
    const result = await terminal.run_terminal_docker({ command: 'ls', workingDir: '../..' });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/traversal/);
    expect(started).toHaveLength(0);
  });
});

function expectRunning(result: { status?: string }): void {
  if (result.status !== 'running') throw new Error(`expected a running command, got ${JSON.stringify(result)}`);
}
