import { useEffect, useId, useState } from 'react';
import { useStore } from 'zustand';

import type { CaptureSource, RecordingDefaults } from '@usee/contracts';

import { Icon, Segmented, Switch, type Choice } from '../editor/ui';
import { messageFor } from '../messages';
import { RecordingStatus } from './RecordingStatus';
import { captureSourceOf, type RecordingSelection, type RecordingStore } from './recording-store';

const SOURCE_KINDS: readonly Choice<CaptureSource['kind']>[] = [
  { value: 'display', label: 'Screen', title: 'Record a whole screen' },
  { value: 'window', label: 'Window', title: 'Record one app window' },
  { value: 'region', label: 'Area', title: 'Record part of a screen' },
];

const FRAME_RATES: readonly Choice<'30' | '60'>[] = [
  { value: '30', label: '30 fps', title: 'Smaller files' },
  { value: '60', label: '60 fps', title: 'Smoother motion' },
];

/** Seconds counted down before a recording starts, when the settings ask for it. */
const COUNTDOWN_SECONDS = 3;

/**
 * Starts and stops a recording. What to record (a screen, one window or an
 * area of a screen) and the microphone are chosen for each recording; the frame rate and pointer choices are remembered as the
 * defaults (`onDefaults`). A countdown, which Escape or Cancel stops, gives
 * time to get to what will be recorded.
 */
export function RecordingPanel({
  store,
  countdown,
  onDefaults,
}: {
  readonly store: RecordingStore;
  readonly countdown: boolean;
  readonly onDefaults: (defaults: RecordingDefaults) => void;
}) {
  const sources = useStore(store, (state) => state.sources);
  const selection = useStore(store, (state) => state.selection);
  const recording = useStore(store, (state) => state.recording);
  const busy = useStore(store, (state) => state.busy);
  const actionError = useStore(store, (state) => state.actionError);
  const { select, refreshSources, chooseRegion, start, stop } = store.getState();
  const windowSelectId = useId();
  /** Seconds left before the recording starts; null when not counting. */
  const [counting, setCounting] = useState<number | null>(null);

  useEffect(() => {
    if (counting === null) {
      return;
    }
    const timer = setTimeout(() => {
      if (counting > 1) {
        setCounting(counting - 1);
      } else {
        setCounting(null);
        void start();
      }
    }, 1_000);
    return () => clearTimeout(timer);
  }, [counting, start]);

  useEffect(() => {
    if (counting === null) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setCounting(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [counting]);

  const active =
    recording.phase === 'preparing' ||
    recording.phase === 'recording' ||
    recording.phase === 'finalizing';
  const canStart =
    !active && !busy && captureSourceOf(selection) !== undefined && counting === null;

  const remember = (
    patch: Partial<Pick<RecordingSelection, 'frameRate' | 'trackPointer' | 'includeCursor'>>,
  ) => {
    select(patch);
    const next = { ...selection, ...patch };
    onDefaults({
      frameRate: next.frameRate,
      trackPointer: next.trackPointer,
      includeCursor: next.includeCursor,
    });
  };

  return (
    <section className="card record-card" aria-labelledby="record-title">
      <header className="card-head">
        <h2 id="record-title">New recording</h2>
        <p className="card-note">
          Records a whole screen, one window or an area. Nothing leaves this computer.
        </p>
      </header>

      <div className="record-fields">
        <div className="field">
          <span className="field-label">Record</span>
          <Segmented
            label="Record"
            value={selection.sourceKind}
            choices={SOURCE_KINDS}
            disabled={active}
            onChange={(sourceKind) => {
              select({ sourceKind });
              if (sourceKind === 'window') {
                void refreshSources();
              }
            }}
          />
        </div>

        {selection.sourceKind !== 'window' ? (
          <label className="field">
            <span>Screen</span>
            <select
              value={selection.displayId ?? ''}
              disabled={active || sources === undefined}
              onChange={(event) => select({ displayId: event.target.value })}
            >
              {sources?.displays.map((display) => (
                <option key={display.id} value={display.id}>
                  {display.name} — {display.width}×{display.height}
                  {display.isPrimary ? ' (primary)' : ''}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="field">
            <label className="field-label" htmlFor={windowSelectId}>
              Window
            </label>
            <div className="window-picker">
              <select
                id={windowSelectId}
                value={selection.windowId ?? ''}
                disabled={active || sources === undefined || sources.windows.length === 0}
                onChange={(event) => select({ windowId: event.target.value })}
              >
                {sources?.windows.length === 0 && <option value="">No open windows</option>}
                {sources?.windows.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.title} — {entry.width}×{entry.height}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="icon-button"
                aria-label="Look for windows again"
                title="Look for windows again"
                disabled={active || busy}
                onClick={() => void refreshSources()}
              >
                <Icon name="refresh" />
              </button>
            </div>
          </div>
        )}

        {selection.sourceKind === 'region' && (
          <div className="field area-field">
            <span className="field-label">Area</span>
            <div
              className={selection.region === null ? 'area-choice empty' : 'area-choice'}
              data-testid="chosen-area"
            >
              <span>
                {selection.region === null
                  ? 'Draw the area to record over the screen.'
                  : `${selection.region.width} × ${selection.region.height} pixels, from ${selection.region.x}, ${selection.region.y}`}
              </span>
              <button
                type="button"
                disabled={active || busy || selection.displayId === null}
                onClick={() => void chooseRegion()}
              >
                {selection.region === null ? 'Choose area' : 'Choose again'}
              </button>
            </div>
          </div>
        )}

        <label className="field">
          <span>Microphone</span>
          <select
            value={selection.audioInputId ?? ''}
            disabled={active || sources === undefined}
            onChange={(event) =>
              select({ audioInputId: event.target.value === '' ? null : event.target.value })
            }
          >
            <option value="">No microphone</option>
            {sources?.audioInputs.map((input) => (
              <option key={input.id} value={input.id}>
                {input.name}
                {input.isDefault ? ' (default)' : ''}
              </option>
            ))}
          </select>
        </label>

        <div className="field">
          <span className="field-label">Frame rate</span>
          <Segmented
            label="Frame rate"
            value={selection.frameRate === 30 ? '30' : '60'}
            choices={FRAME_RATES}
            disabled={active}
            onChange={(rate) => remember({ frameRate: rate === '30' ? 30 : 60 })}
          />
        </div>

        <div className="field pointer-field">
          <span className="field-label">Mouse pointer</span>
          <Switch
            label="Record it for cursor effects"
            checked={selection.trackPointer}
            disabled={active}
            onChange={(trackPointer) => remember({ trackPointer })}
          />
          <Switch
            label="Show it in the video"
            checked={!selection.trackPointer && selection.includeCursor}
            disabled={active || selection.trackPointer}
            onChange={(includeCursor) => remember({ includeCursor })}
          />
          <span className="field-note">
            {selection.trackPointer
              ? 'Records where the pointer moves, its clicks and its shape, never keystrokes. The editor draws the cursor.'
              : 'Without a recorded pointer there are no cursor effects or zooms on clicks.'}
          </span>
        </div>
      </div>

      <div className="record-actions">
        {recording.phase === 'recording' ? (
          <button
            type="button"
            className="record-button stop"
            onClick={() => void stop()}
            disabled={busy}
          >
            <span className="record-glyph" aria-hidden="true" />
            Stop recording
          </button>
        ) : (
          <button
            type="button"
            className="record-button"
            onClick={() => (countdown ? setCounting(COUNTDOWN_SECONDS) : void start())}
            disabled={!canStart}
          >
            <span className="record-glyph" aria-hidden="true" />
            Start recording
          </button>
        )}
        <RecordingStatus state={recording} />
      </div>
      {counting !== null && (
        <div className="countdown" role="status" aria-live="assertive" data-testid="countdown">
          <span className="countdown-number" key={counting}>
            {counting}
          </span>
          <span className="countdown-note">Recording starts in {counting}. Escape cancels.</span>
          <button type="button" onClick={() => setCounting(null)}>
            Cancel
          </button>
        </div>
      )}
      {actionError !== undefined && recording.phase !== 'failed' && (
        <p className="status status-error" role="alert">
          {messageFor(actionError.userMessageKey)} Support reference: {actionError.correlationId}
        </p>
      )}
    </section>
  );
}
