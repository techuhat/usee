/**
 * Cooperative cancellation. Long-running work checks the token at safe
 * boundaries (a segment, a frame batch) instead of being killed mid-write.
 */
export interface CancellationToken {
  readonly isCancellationRequested: boolean;
  throwIfCancellationRequested(): void;
}
