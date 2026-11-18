import type { RecordingState } from '@usee/contracts';

import { messageFor } from '../messages';
import { formatDuration } from './format';

export function RecordingStatus({ state }: { readonly state: RecordingState }) {
  switch (state.phase) {
    case 'idle':
      return <p className="status">Ready to record.</p>;
    case 'preparing':
      return <p className="status">Starting…</p>;
    case 'recording': {
      const details = [
        `${state.metrics.framesDropped} dropped ${state.metrics.framesDropped === 1 ? 'frame' : 'frames'}`,
        state.microphone === 'on'
          ? 'Microphone on'
          : state.microphone === 'failed'
            ? 'Microphone stopped'
            : 'No microphone',
        state.hardwareEncoder ? 'Hardware encoder' : 'Software encoder',
        'Ctrl+Shift+F10 stops',
      ];
      return (
        <p className="status status-live" data-testid="recording-status">
          <span className="live-dot" aria-hidden="true" />
          Recording {formatDuration(state.metrics.elapsedUs)} · {details.join(' · ')}
        </p>
      );
    }
    case 'finalizing':
      return <p className="status">Saving the recording…</p>;
    case 'completed':
      return (
        <div className="status status-done" data-testid="recording-status">
          <p>
            Saved {formatDuration(state.durationUs)} of video
            {state.framesDropped > 0
              ? ` (${state.framesDropped} dropped ${state.framesDropped === 1 ? 'frame' : 'frames'})`
              : ''}
            .
          </p>
          <p className="path" data-testid="project-path">
            {state.projectPath}
          </p>
        </div>
      );
    case 'failed':
      return (
        <div className="status status-error" role="alert" data-testid="recording-status">
          <p>
            {messageFor(state.error.userMessageKey)} Support reference: {state.error.correlationId}
          </p>
          {state.projectPath !== null && (
            <p>
              What was recorded before the problem was saved to{' '}
              <span className="path">{state.projectPath}</span>.
            </p>
          )}
        </div>
      );
  }
}
