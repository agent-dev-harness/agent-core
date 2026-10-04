import { describe, it, expect } from 'vitest';
import { parseExecToolArgs, truncateExecResult, MAX_TOOL_OUTPUT_CHARS, MIN_WAIT_SECONDS, MAX_WAIT_SECONDS, DEFAULT_INITIAL_WAIT_SECONDS } from '../../src/execTool';
import { resolveWorkDir, TRAVERSAL_ERROR } from '../../src/workspace/execHelpers';

describe('parseExecToolArgs', () => {
  it('parses command, workingDir, initialWaitSeconds and mode', () => {
    expect(parseExecToolArgs({ command: 'ls', workingDir: 'docs', initialWaitSeconds: 120, mode: 'async' })).toEqual({
      command: 'ls',
      workDir: 'docs',
      initialWaitMs: 120_000,
      mode: 'async',
    });
  });

  it('defaults to root workDir, sync mode and the default initial wait', () => {
    expect(parseExecToolArgs({ command: 'pwd' })).toEqual({
      command: 'pwd',
      workDir: undefined,
      initialWaitMs: DEFAULT_INITIAL_WAIT_SECONDS * 1000,
      mode: 'sync',
    });
    expect(parseExecToolArgs(undefined)).toEqual({
      command: '',
      workDir: undefined,
      initialWaitMs: DEFAULT_INITIAL_WAIT_SECONDS * 1000,
      mode: 'sync',
    });
  });

  it('clamps initialWaitSeconds into 0..600, falling back to the default on invalid input', () => {
    expect(parseExecToolArgs({ command: 'x', initialWaitSeconds: -5 }).initialWaitMs).toBe(MIN_WAIT_SECONDS * 1000);
    expect(parseExecToolArgs({ command: 'x', initialWaitSeconds: 100_000 }).initialWaitMs).toBe(MAX_WAIT_SECONDS * 1000);
    expect(parseExecToolArgs({ command: 'x', initialWaitSeconds: Number.NaN }).initialWaitMs).toBe(DEFAULT_INITIAL_WAIT_SECONDS * 1000);
    expect(parseExecToolArgs({ command: 'x', initialWaitSeconds: 'soon' }).initialWaitMs).toBe(DEFAULT_INITIAL_WAIT_SECONDS * 1000);
  });

  it('accepts a number sent as a string, as models often do', () => {
    expect(parseExecToolArgs({ command: 'x', initialWaitSeconds: '300' }).initialWaitMs).toBe(300_000);
  });

  it('treats any mode other than "async" as sync', () => {
    expect(parseExecToolArgs({ command: 'x', mode: 'background' }).mode).toBe('sync');
  });
});

describe('resolveWorkDir', () => {
  const ROOT = '/ws/root';

  it('resolves relative paths against the workspace root', () => {
    expect(resolveWorkDir('docs', ROOT)).toEqual({ ok: true, dir: '/ws/root/docs' });
    expect(resolveWorkDir('./src/../test', ROOT)).toEqual({ ok: true, dir: '/ws/root/test' });
  });

  it('keeps absolute paths that stay inside the root', () => {
    expect(resolveWorkDir('/ws/root/deep/dir', ROOT)).toEqual({ ok: true, dir: '/ws/root/deep/dir' });
    expect(resolveWorkDir('/ws/root', ROOT)).toEqual({ ok: true, dir: ROOT });
  });

  it('rejects traversal in both relative and absolute form', () => {
    expect(resolveWorkDir('../../etc', ROOT)).toEqual({ ok: false, error: TRAVERSAL_ERROR });
    expect(resolveWorkDir('docs/../../..', ROOT)).toEqual({ ok: false, error: TRAVERSAL_ERROR });
    expect(resolveWorkDir('/etc', ROOT)).toEqual({ ok: false, error: TRAVERSAL_ERROR });
    expect(resolveWorkDir('/ws/rootEvil', ROOT)).toEqual({ ok: false, error: TRAVERSAL_ERROR });
  });

  it('accepts the root itself when the root is given with a trailing slash', () => {
    expect(resolveWorkDir('.', '/ws/root/')).toEqual({ ok: true, dir: ROOT });
    expect(resolveWorkDir('/ws/root', '/ws/root/')).toEqual({ ok: true, dir: ROOT });
    expect(resolveWorkDir('docs', '/ws/root/')).toEqual({ ok: true, dir: '/ws/root/docs' });
    expect(resolveWorkDir('/ws/rootEvil', '/ws/root/')).toEqual({ ok: false, error: TRAVERSAL_ERROR });
  });

  it('treats empty/blank as the workspace root', () => {
    expect(resolveWorkDir(undefined, ROOT)).toEqual({ ok: true, dir: ROOT });
    expect(resolveWorkDir('', ROOT)).toEqual({ ok: true, dir: ROOT });
    expect(resolveWorkDir('   ', ROOT)).toEqual({ ok: true, dir: ROOT });
  });
});

describe('truncateExecResult', () => {
  it('leaves small results untouched', () => {
    const result = { stdout: 'ok', stderr: '', exitCode: 0 };
    expect(truncateExecResult(result)).toEqual(result);
  });

  it('caps oversized stdout with a head+tail window and a notice', () => {
    const big = 'A'.repeat(10_000) + 'Q'.repeat(60_000) + 'MIDDLE_MARK' + 'Q'.repeat(60_000) + 'Z'.repeat(10_000);
    const result = truncateExecResult({ stdout: big, stderr: '', exitCode: 0 });
    expect(result.stdout.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
    expect(result.stdout.startsWith('A'.repeat(100))).toBe(true);
    expect(result.stdout.endsWith('Z'.repeat(100))).toBe(true);
    expect(result.stdout).toContain('Output truncated');
    expect(result.stdout).not.toContain('MIDDLE_MARK');
  });

  it('truncates stderr independently', () => {
    const result = truncateExecResult({ stdout: '', stderr: 'E'.repeat(MAX_TOOL_OUTPUT_CHARS + 1), exitCode: 1 });
    expect(result.stderr.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
    expect(result.stderr).toContain('Output truncated');
  });
});
