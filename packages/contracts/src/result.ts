import { z } from 'zod';

import { appErrorSchema, type AppError } from './errors';

export interface Ok<Value> {
  readonly ok: true;
  readonly value: Value;
}

export interface Err<Failure> {
  readonly ok: false;
  readonly error: Failure;
}

/** Application ports and asynchronous command boundaries return this, never throw. */
export type Result<Value, Failure = AppError> = Ok<Value> | Err<Failure>;

export function ok<Value>(value: Value): Ok<Value> {
  return { ok: true, value };
}

export function err<Failure>(error: Failure): Err<Failure> {
  return { ok: false, error };
}

/** Schema for a `Result` whose success value is described by `value`. */
export function resultSchema<Value extends z.ZodType>(value: Value) {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value }).readonly(),
    z.object({ ok: z.literal(false), error: appErrorSchema }).readonly(),
  ]);
}
