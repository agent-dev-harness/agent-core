import { describe, expect, it } from 'vitest';
import { OutputCollector } from '../../src/workspace/execHelpers';

const LIMIT = { maxChars: 40, headChars: 26, tailChars: 13 };

function collect(text: string, chunkSize: number): string {
  const collector = new OutputCollector(LIMIT);
  for (let i = 0; i < text.length; i += chunkSize) collector.write(text.slice(i, i + chunkSize));
  return collector.finish();
}

describe('OutputCollector', () => {
  it('keeps a multibyte character that is split across chunks', () => {
    const bytes = Buffer.from('a€b', 'utf8');
    const collector = new OutputCollector();
    collector.write(bytes.subarray(0, 2));
    collector.write(bytes.subarray(2));
    expect(collector.finish()).toBe('a€b');
  });

  it('returns output up to maxChars unchanged', () => {
    const text = 'x'.repeat(40);
    expect(collect(text, 7)).toBe(text);
  });

  it('keeps the head and tail of longer output and counts what it dropped', () => {
    const text = 'H'.repeat(26) + 'm'.repeat(100) + 'T'.repeat(13);
    expect(collect(text, 1000)).toBe(
      'H'.repeat(26) + '\n[run_terminal_docker] Output truncated: omitted 100 middle characters.\n' + 'T'.repeat(13),
    );
  });

  it('gives the same result however the output is chunked', () => {
    const text = Array.from({ length: 500 }, (_, i) => String.fromCharCode(33 + (i % 90))).join('');
    for (const length of [39, 40, 41, 52, 53, 54, 500]) {
      const expected = collect(text.slice(0, length), length);
      for (const chunkSize of [1, 3, 13, 14, 27]) {
        expect(collect(text.slice(0, length), chunkSize)).toBe(expected);
      }
    }
  });

  it('does not cut a surrogate pair in half at either edge', () => {
    const text = 'a'.repeat(25) + '😀' + 'm'.repeat(50) + '😀' + 'z'.repeat(12);
    expect(collect(text, 5)).toBe(
      'a'.repeat(25) + '\n[run_terminal_docker] Output truncated: omitted 54 middle characters.\n' + 'z'.repeat(12),
    );
  });

  it('bounds memory even when no limit is passed', () => {
    const chunk = Buffer.alloc(1 << 20, 'a');
    const collector = new OutputCollector();
    for (let i = 0; i < 600; i++) collector.write(chunk);
    expect(collector.finish()).toContain('Output truncated');
  });

  it('bounds memory for output larger than the maximum string length', () => {
    const chunk = Buffer.alloc(1 << 20, 'a');
    const collector = new OutputCollector(LIMIT);
    for (let i = 0; i < 600; i++) collector.write(chunk);
    expect(collector.finish()).toContain(`omitted ${600 * (1 << 20) - 39} middle characters`);
  });
});
