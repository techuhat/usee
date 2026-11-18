import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { createAppError } from './errors';
import { asCorrelationId } from './ids';
import { err, ok, resultSchema } from './result';

const failure = createAppError({
  category: 'native',
  code: 'native.host-unavailable',
  retryable: true,
  userMessageKey: 'errors.native.host-unavailable',
  correlationId: asCorrelationId('abc123'),
});

describe('resultSchema', () => {
  const schema = resultSchema(z.object({ count: z.number().int() }));

  it('accepts success and failure variants', () => {
    expect(schema.parse(ok({ count: 3 }))).toEqual({ ok: true, value: { count: 3 } });
    expect(schema.parse(err(failure))).toEqual({ ok: false, error: failure });
  });

  it('rejects a success whose value does not match', () => {
    expect(schema.safeParse(ok({ count: 'three' })).success).toBe(false);
  });

  it('rejects a failure whose error is not an AppError', () => {
    expect(schema.safeParse(err(new Error('boom'))).success).toBe(false);
  });

  it('rejects values that are not results at all', () => {
    for (const value of [undefined, null, 'ok', { ok: 'true', value: 1 }]) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });
});
