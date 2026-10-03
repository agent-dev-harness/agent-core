import { describe, expect, it } from 'vitest';
import { execCommand } from '../../src/workspace/nativeRunner';

describe('how the native runner feeds the command to bash', () => {
  it('gives commands an empty stdin, so they cannot consume the lines after them', async () => {
    const result = await execCommand('cat\necho line2-ran\nread x || echo "read hit EOF"');
    expect(result).toEqual({ stdout: 'line2-ran\nread hit EOF\n', stderr: '', exitCode: 0 });
  });

  it('keeps exit codes, heredocs and multi-line syntax', async () => {
    const result = await execCommand("cat <<'EOF'\nhello $HOME\nEOF\nfor i in 1 2; do\n  echo $i\ndone\nexit 7");
    expect(result).toEqual({ stdout: 'hello $HOME\n1\n2\n', stderr: '', exitCode: 7 });
  });

  it('runs scripts larger than the kernel limit for a single argument', async () => {
    const result = await execCommand(`: '${'x'.repeat(1_000_000)}'\necho big-ok`);
    expect(result.stdout).toBe('big-ok\n');
  });
});
