import type { TimestampUs } from '@usee/contracts';

export type Easing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';

export interface Keyframe<Value> {
  readonly timestampUs: TimestampUs;
  readonly value: Value;
  readonly easing: Easing;
}
