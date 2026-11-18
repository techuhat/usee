import type { DurationUs, TimestampUs } from '@usee/contracts';

/** A half-open span `[startUs, startUs + durationUs)` on one clock. */
export interface TimeRange {
  readonly startUs: TimestampUs;
  readonly durationUs: DurationUs;
}
