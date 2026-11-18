import { describe, expect, it } from 'vitest';

import { asDurationUs, asSchemaVersion, asTimestampUs, timestampUsSchema } from './time';

describe('time units', () => {
  it('accepts non-negative integer microseconds', () => {
    expect(asTimestampUs(0)).toBe(0);
    expect(asDurationUs(16_667)).toBe(16_667);
    expect(timestampUsSchema.parse(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects %d as a timestamp',
    (value) => {
      expect(() => asTimestampUs(value)).toThrow(RangeError);
      expect(timestampUsSchema.safeParse(value).success).toBe(false);
    },
  );

  it('requires schema versions to start at 1', () => {
    expect(asSchemaVersion(1)).toBe(1);
    expect(() => asSchemaVersion(0)).toThrow(RangeError);
  });
});
