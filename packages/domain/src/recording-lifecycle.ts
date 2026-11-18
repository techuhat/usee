import type { RecordingSessionId } from '@usee/contracts';

/**
 * The Phase 1 subset of the recording lifecycle in docs/recording-pipeline.md:
 * Idle → Preparing → Recording → Finalizing → Completed | Failed. Pause and
 * the separate Ready step arrive with backends that support them.
 */
export type RecordingLifecycle =
  | { readonly phase: 'idle' }
  | { readonly phase: 'preparing'; readonly sessionId: RecordingSessionId }
  | { readonly phase: 'recording'; readonly sessionId: RecordingSessionId }
  | { readonly phase: 'finalizing'; readonly sessionId: RecordingSessionId }
  | { readonly phase: 'completed'; readonly sessionId: RecordingSessionId }
  | { readonly phase: 'failed'; readonly sessionId: RecordingSessionId };

export type RecordingPhase = RecordingLifecycle['phase'];

export type RecordingLifecycleEvent =
  | { readonly type: 'prepare'; readonly sessionId: RecordingSessionId }
  | { readonly type: 'started' }
  | { readonly type: 'stop' }
  | { readonly type: 'finalized' }
  | { readonly type: 'fail' };

export const IDLE_RECORDING: RecordingLifecycle = Object.freeze({ phase: 'idle' });

/**
 * Applies one event. Repeating an event that already took effect returns the
 * same state (transitions are idempotent); any other disallowed transition
 * returns `undefined` so callers can refuse it.
 */
export function nextRecordingState(
  state: RecordingLifecycle,
  event: RecordingLifecycleEvent,
): RecordingLifecycle | undefined {
  switch (event.type) {
    case 'prepare':
      if (state.phase === 'idle' || state.phase === 'completed' || state.phase === 'failed') {
        return { phase: 'preparing', sessionId: event.sessionId };
      }
      return state.phase === 'preparing' && state.sessionId === event.sessionId ? state : undefined;
    case 'started':
      if (state.phase === 'preparing') {
        return { phase: 'recording', sessionId: state.sessionId };
      }
      return state.phase === 'recording' ? state : undefined;
    case 'stop':
      if (state.phase === 'recording') {
        return { phase: 'finalizing', sessionId: state.sessionId };
      }
      return state.phase === 'finalizing' ? state : undefined;
    case 'finalized':
      if (state.phase === 'finalizing') {
        return { phase: 'completed', sessionId: state.sessionId };
      }
      return state.phase === 'completed' ? state : undefined;
    case 'fail':
      if (
        state.phase === 'preparing' ||
        state.phase === 'recording' ||
        state.phase === 'finalizing'
      ) {
        return { phase: 'failed', sessionId: state.sessionId };
      }
      return state.phase === 'failed' ? state : undefined;
  }
}
