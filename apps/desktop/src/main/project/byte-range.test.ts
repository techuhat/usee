import { describe, expect, it } from 'vitest';

import { parseByteRange } from './byte-range';

describe('parseByteRange', () => {
  it('reads the forms media elements send', () => {
    expect(parseByteRange('bytes=0-', 1_000)).toEqual({ start: 0, end: 999 });
    expect(parseByteRange('bytes=100-199', 1_000)).toEqual({ start: 100, end: 199 });
    expect(parseByteRange('bytes=900-5000', 1_000)).toEqual({ start: 900, end: 999 });
    expect(parseByteRange('bytes=-100', 1_000)).toEqual({ start: 900, end: 999 });
    expect(parseByteRange('bytes=-5000', 1_000)).toEqual({ start: 0, end: 999 });
  });

  it('sends the whole file without a usable header', () => {
    expect(parseByteRange(null, 1_000)).toBeUndefined();
    expect(parseByteRange('bytes=0-1,5-9', 1_000)).toBeUndefined();
    expect(parseByteRange('items=0-1', 1_000)).toBeUndefined();
    expect(parseByteRange('bytes=-', 1_000)).toBeUndefined();
  });

  it('refuses ranges outside the file', () => {
    expect(parseByteRange('bytes=1000-', 1_000)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=500-100', 1_000)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=-0', 1_000)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=0-', 0)).toBe('unsatisfiable');
  });
});
