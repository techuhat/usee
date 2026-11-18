import { describe, expect, it } from 'vitest';

import { appErrorSchema, createAppError, type AppErrorFields } from './errors';
import { asCorrelationId } from './ids';

const valid: AppErrorFields = {
  category: 'ipc',
  code: 'ipc.invalid-request',
  retryable: false,
  userMessageKey: 'errors.ipc.invalid-request',
  correlationId: asCorrelationId('c0ffee'),
};

describe('AppError', () => {
  it('builds a validated error with optional redacted context', () => {
    const error = createAppError({ ...valid, diagnosticContext: { channel: 'x', attempts: 2 } });
    expect(error).toEqual({ ...valid, diagnosticContext: { channel: 'x', attempts: 2 } });
  });

  it('requires the code to start with its category', () => {
    expect(() => createAppError({ ...valid, code: 'capture.source-closed' })).toThrow();
  });

  it.each(['IPC.bad', 'ipc', 'ipc.Bad_Code', 'ipc.bad code'])(
    'rejects malformed code %j',
    (code) => {
      expect(appErrorSchema.safeParse({ ...valid, code }).success).toBe(false);
    },
  );

  it('rejects unknown categories and missing correlation IDs', () => {
    expect(appErrorSchema.safeParse({ ...valid, category: 'validation' }).success).toBe(false);
    const { correlationId: _omitted, ...withoutCorrelation } = valid;
    expect(appErrorSchema.safeParse(withoutCorrelation).success).toBe(false);
  });

  it('bounds diagnostic strings so errors stay small on the wire', () => {
    const oversized = { ...valid, diagnosticContext: { detail: 'x'.repeat(513) } };
    expect(appErrorSchema.safeParse(oversized).success).toBe(false);
  });
});
