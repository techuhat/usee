import { useState } from 'react';
import { useStore } from 'zustand';

import { formatDuration } from './format';
import type { RecordingStore } from './recording-store';

/**
 * Offers to import recordings that were cut off by a crash. Nothing is
 * imported or deleted without an explicit choice (docs/project-format.md).
 */
export function RecoveryBanner({ store }: { readonly store: RecordingStore }) {
  const interrupted = useStore(store, (state) => state.interrupted);
  const recoveredPath = useStore(store, (state) => state.recoveredPath);
  const busy = useStore(store, (state) => state.busy);
  const [confirming, setConfirming] = useState<string | undefined>(undefined);
  const { recover, discard } = store.getState();

  if (interrupted.length === 0 && recoveredPath === undefined) {
    return null;
  }

  return (
    <section className="panel recovery" aria-labelledby="recovery-title">
      <h2 id="recovery-title">Interrupted recordings</h2>
      {recoveredPath !== undefined && (
        <p className="status status-done">
          Recovered to <span className="path">{recoveredPath}</span>.
        </p>
      )}
      <ul className="recovery-list">
        {interrupted.map((session) => (
          <li key={session.sessionId}>
            <span>
              {session.startedAt === null
                ? 'Unknown time'
                : new Date(session.startedAt).toLocaleString()}{' '}
              · {formatDuration(session.durationUs)} · {session.segmentCount} segments
            </span>
            {confirming === session.sessionId ? (
              <span className="actions">
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => void discard(session.sessionId)}
                >
                  Delete permanently
                </button>
                <button type="button" onClick={() => setConfirming(undefined)}>
                  Keep
                </button>
              </span>
            ) : (
              <span className="actions">
                <button
                  type="button"
                  disabled={busy || session.segmentCount === 0}
                  onClick={() => void recover(session.sessionId)}
                >
                  Recover
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirming(session.sessionId)}
                >
                  Discard
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
