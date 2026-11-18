import { z } from 'zod';

import type { Brand } from './brand';

/**
 * Integer microseconds relative to a session or project epoch. Media time is
 * never stored as floating-point seconds or wall-clock values
 * (docs/recording-pipeline.md, "Timestamping and coordinate spaces").
 */
export type TimestampUs = Brand<number, 'TimestampUs'>;
export type DurationUs = Brand<number, 'DurationUs'>;

/** Monotonic integer version of a persisted or wire schema. */
export type SchemaVersion = Brand<number, 'SchemaVersion'>;

function nonNegativeSafeInteger<Value extends number>(kind: string) {
  return (value: number): Value => {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`Invalid ${kind}: expected a non-negative safe integer, got ${value}.`);
    }
    return value as Value;
  };
}

export const asTimestampUs = nonNegativeSafeInteger<TimestampUs>('TimestampUs');
export const asDurationUs = nonNegativeSafeInteger<DurationUs>('DurationUs');

export function asSchemaVersion(value: number): SchemaVersion {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`Invalid SchemaVersion: expected a positive integer, got ${value}.`);
  }
  return value as SchemaVersion;
}

const nonNegativeInteger = z.number().int().nonnegative();

export const timestampUsSchema = nonNegativeInteger.transform((value) => value as TimestampUs);
export const durationUsSchema = nonNegativeInteger.transform((value) => value as DurationUs);
export const schemaVersionSchema = z
  .number()
  .int()
  .positive()
  .transform((value) => value as SchemaVersion);
