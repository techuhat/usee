import { describe, expect, it } from 'vitest';

import { asRecordingSessionId } from '@usee/contracts';

import {
  IDLE_RECORDING,
  nextRecordingState,
  type RecordingLifecycle,
  type RecordingLifecycleEvent,
} from './recording-lifecycle';

const a = asRecordingSessionId('session-a');
const b = asRecordingSessionId('session-b');

function run(...events: RecordingLifecycleEvent[]): RecordingLifecycle | undefined {
  let state: RecordingLifecycle | undefined = IDLE_RECORDING;
  for (const event of events) {
    state = state === undefined ? undefined : nextRecordingState(state, event);
  }
  return state;
}

describe('recording lifecycle', () => {
  it('follows the documented happy path', () => {
    expect(run({ type: 'prepare', sessionId: a })).toEqual({ phase: 'preparing', sessionId: a });
    expect(run({ type: 'prepare', sessionId: a }, { type: 'started' })).toEqual({
      phase: 'recording',
      sessionId: a,
    });
    expect(
      run(
        { type: 'prepare', sessionId: a },
        { type: 'started' },
        { type: 'stop' },
        { type: 'finalized' },
      ),
    ).toEqual({ phase: 'completed', sessionId: a });
  });

  it('treats a repeated event as a no-op', () => {
    const recording = run({ type: 'prepare', sessionId: a }, { type: 'started' });
    expect(recording).toBeDefined();
    if (recording === undefined) return;
    expect(nextRecordingState(recording, { type: 'started' })).toBe(recording);

    const finalizing = nextRecordingState(recording, { type: 'stop' });
    expect(finalizing && nextRecordingState(finalizing, { type: 'stop' })).toBe(finalizing);
  });

  it('refuses transitions the lifecycle does not allow', () => {
    expect(run({ type: 'started' })).toBeUndefined();
    expect(run({ type: 'stop' })).toBeUndefined();
    expect(run({ type: 'finalized' })).toBeUndefined();
    expect(run({ type: 'fail' })).toBeUndefined();
    expect(
      run({ type: 'prepare', sessionId: a }, { type: 'prepare', sessionId: b }),
    ).toBeUndefined();
    expect(run({ type: 'prepare', sessionId: a }, { type: 'stop' })).toBeUndefined();
  });

  it('fails from any active phase and allows a new session afterwards', () => {
    for (const events of [
      [{ type: 'prepare', sessionId: a }],
      [{ type: 'prepare', sessionId: a }, { type: 'started' }],
      [{ type: 'prepare', sessionId: a }, { type: 'started' }, { type: 'stop' }],
    ] as RecordingLifecycleEvent[][]) {
      expect(run(...events, { type: 'fail' })).toEqual({ phase: 'failed', sessionId: a });
    }
    expect(
      run({ type: 'prepare', sessionId: a }, { type: 'fail' }, { type: 'prepare', sessionId: b }),
    ).toEqual({ phase: 'preparing', sessionId: b });
  });
});
