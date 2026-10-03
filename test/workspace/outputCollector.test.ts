import { describe, expect, it } from 'vitest';
import { OutputCollector } from '../../src/workspace/execHelpers';

describe('OutputCollector', () => {
  it('keeps a multibyte character that is split across chunks', () => {
    const bytes = Buffer.from('a€b', 'utf8');
    const collector = new OutputCollector();
    collector.write(bytes.subarray(0, 2));
    collector.write(bytes.subarray(2));
    expect(collector.finish()).toBe('a€b');
  });
});
