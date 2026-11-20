import { useEffect, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';

import type { ExportRuntimeStatusDto, NewProjectDefaults } from '@usee/contracts';

import { CommitSlider } from '../editor/controls';
import { EXPORT_QUALITIES, type ExportPresetId } from '../editor/export-qualities';
import { Icon, Segmented, Swatches, Switch, type Choice } from '../editor/ui';
import { messageFor } from '../messages';
import type { RuntimeInfoState } from '../runtime/use-runtime-info';
import { canvasForLook, LOOK_SWATCHES, lookOf } from './looks';
import type { SettingsStore } from './settings-store';

const FRAME_RATES: readonly Choice<'30' | '60'>[] = [
  { value: '30', label: '30 fps' },
  { value: '60', label: '60 fps' },
];

const QUALITIES: readonly Choice<ExportPresetId>[] = EXPORT_QUALITIES.map(({ id, label }) => ({
  value: id,
  label,
}));

/** The editor's keys, as its hint line and buttons name them. */
const SHORTCUTS: readonly (readonly [string, string])[] = [
  ['Space', 'Play or pause'],
  ['S', 'Split the clip at the playhead'],
  ['Z', 'Add a zoom at the playhead'],
  ['B', 'Add a blur at the playhead'],
  ['Delete', 'Remove what is selected'],
  ['[ and ]', 'Trim the selected clip to the playhead'],
  ['← and →', 'Step one frame'],
  ['Ctrl + Z', 'Undo'],
  ['Ctrl + Shift + Z', 'Redo'],
  ['Ctrl + wheel', 'Zoom the timeline'],
  ['Ctrl + Shift + F10', 'Stop recording, from any app'],
];

function Card({
  id,
  title,
  wide = false,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly wide?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <section
      className={wide ? 'card settings-card wide' : 'card settings-card'}
      aria-labelledby={id}
    >
      <h3 id={id}>{title}</h3>
      {children}
    </section>
  );
}

/** Whether export can run on this computer, as the export panel would say it. */
function useExportRuntime(): ExportRuntimeStatusDto | null {
  const [runtime, setRuntime] = useState<ExportRuntimeStatusDto | null>(null);
  useEffect(() => {
    let current = true;
    void window.desktop.getExportQueue().then((result) => {
      if (current && result.ok) {
        setRuntime(result.value.runtime);
      }
    });
    return () => {
      current = false;
    };
  }, []);
  return runtime;
}

function exportStatus(runtime: ExportRuntimeStatusDto | null): string {
  if (runtime === null) {
    return 'Checking the video encoder…';
  }
  if (runtime.available) {
    return 'Ready: H.264 video on your graphics card when it can, AAC audio, in an MP4 file.';
  }
  return runtime.reason === null
    ? 'The approved video encoder is unavailable.'
    : messageFor(`errors.${runtime.reason}`);
}

/** The user's preferences, saved on this computer as they change. */
export function SettingsPage({
  settings,
  runtime,
  onShowWelcome,
}: {
  readonly settings: SettingsStore;
  readonly runtime: RuntimeInfoState;
  /** Opens the welcome tour a first start shows. */
  readonly onShowWelcome: () => void;
}) {
  const current = useStore(settings, (state) => state.settings);
  const error = useStore(settings, (state) => state.error);
  const exportRuntime = useExportRuntime();
  const [folderError, setFolderError] = useState<string | null>(null);
  const { update, dismissError } = settings.getState();

  const head = (
    <header className="page-head">
      <div>
        <h2>Settings</h2>
        <p className="page-note">Saved on this computer as you change them.</p>
      </div>
    </header>
  );
  const problem = error !== undefined && (
    <p className="status status-error" role="alert">
      {messageFor(error.userMessageKey)} Support reference: {error.correlationId}{' '}
      <button type="button" onClick={dismissError}>
        Dismiss
      </button>
    </p>
  );
  if (current === undefined) {
    return (
      <div className="page-body">
        {head}
        {problem}
        {error === undefined && <p className="empty-note">Loading your settings…</p>}
      </div>
    );
  }

  const { recording, newProjects } = current;
  const looks = (patch: Partial<NewProjectDefaults>) =>
    void update({ newProjects: { ...newProjects, ...patch } });
  const showFolder = async () => {
    setFolderError(null);
    const result = await window.desktop.showProjectsFolder();
    if (!result.ok) {
      setFolderError(messageFor(result.error.userMessageKey));
    }
  };

  return (
    <div className="page-body">
      {head}
      {problem}
      <div className="settings-grid">
        <Card id="settings-recording" title="Recording">
          <div className="field">
            <span className="field-label">Frame rate</span>
            <Segmented
              label="Frame rate"
              value={recording.frameRate === 30 ? '30' : '60'}
              choices={FRAME_RATES}
              onChange={(rate) =>
                void update({ recording: { ...recording, frameRate: rate === '30' ? 30 : 60 } })
              }
            />
          </div>
          <Switch
            label="Record the pointer for cursor effects"
            checked={recording.trackPointer}
            onChange={(trackPointer) => void update({ recording: { ...recording, trackPointer } })}
          />
          <Switch
            label="Show the pointer in the video"
            checked={!recording.trackPointer && recording.includeCursor}
            disabled={recording.trackPointer}
            onChange={(includeCursor) =>
              void update({ recording: { ...recording, includeCursor } })
            }
          />
          <Switch
            label="Count down 3 seconds first"
            checked={recording.countdown !== false}
            onChange={(countdown) => void update({ recording: { ...recording, countdown } })}
          />
          <Switch
            label="Hide usee while recording"
            checked={recording.hideWhileRecording !== false}
            onChange={(hideWhileRecording) =>
              void update({ recording: { ...recording, hideWhileRecording } })
            }
          />
          <p className="field-note">
            Stop with Ctrl+Shift+F10 or the red dot by the clock. The microphone stays off until you
            pick one for a recording, every time.
          </p>
        </Card>

        <Card id="settings-new" title="New recordings">
          <Switch
            label="Zoom in on clicks"
            checked={newProjects.autoZoom}
            onChange={(autoZoom) => looks({ autoZoom })}
          />
          <CommitSlider
            label="Zoom depth"
            value={newProjects.zoomScale}
            min={1.2}
            max={4}
            step={0.1}
            format={(value) => `${value.toFixed(1)}×`}
            disabled={!newProjects.autoZoom}
            onCommit={(zoomScale) => looks({ zoomScale })}
          />
          <Switch
            label="3D motion toward each action"
            checked={newProjects.turn3d > 0}
            disabled={!newProjects.autoZoom}
            onChange={(on) => looks({ turn3d: on ? 0.6 : 0 })}
          />
          <CommitSlider
            label="3D turn"
            value={newProjects.turn3d}
            min={0.1}
            max={1}
            step={0.05}
            format={(value) => `${Math.round(value * 100)}%`}
            disabled={!newProjects.autoZoom || newProjects.turn3d === 0}
            onCommit={(turn3d) => looks({ turn3d })}
          />
          <div className="field">
            <span className="field-label">Background</span>
            <Swatches
              label="Background"
              swatches={LOOK_SWATCHES}
              selected={lookOf(newProjects.canvas)}
              onPick={(swatch) => looks({ canvas: canvasForLook(swatch.id) })}
            />
          </div>
          <p className="field-note">
            Each recording keeps its own copy: changing these never changes one you made before.
          </p>
        </Card>

        <Card id="settings-camera" title="Automatic camera">
          <Switch
            label="Follow changes on screen"
            checked={current.analysis?.pictureFocus === true}
            onChange={(pictureFocus) => void update({ analysis: { pictureFocus } })}
          />
          <p className="field-note">
            Besides clicks and where the pointer rests, the camera looks where menus, dialogs and
            typing change the picture. The editor reads each recording in the background, never
            keystrokes.
          </p>
        </Card>

        <Card id="settings-export" title="Export">
          <div className="field">
            <span className="field-label">Quality</span>
            <Segmented
              label="Quality"
              value={current.export.presetId}
              choices={QUALITIES}
              columns={2}
              onChange={(presetId) => void update({ export: { presetId } })}
            />
          </div>
          <p className="field-note" role="status">
            {exportStatus(exportRuntime)}
          </p>
        </Card>

        <Card id="settings-storage" title="Storage">
          <p className="card-text">
            Each recording is a project folder in your recordings folder, with its video, audio and
            pointer data. Nothing is uploaded.
          </p>
          <button type="button" onClick={() => void showFolder()}>
            <Icon name="folder" />
            Show recordings folder
          </button>
          {folderError !== null && (
            <p className="status status-error" role="alert">
              {folderError}
            </p>
          )}
        </Card>

        <Card id="settings-keys" title="Keyboard shortcuts" wide>
          <dl className="shortcuts">
            {SHORTCUTS.map(([keys, action]) => (
              <div key={keys}>
                <dt>
                  <kbd>{keys}</kbd>
                </dt>
                <dd>{action}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card id="settings-about" title="About" wide>
          <p className="card-text">
            {runtime.status === 'ready'
              ? `usee ${runtime.info.applicationVersion} for ${runtime.info.platform} ${runtime.info.architecture}, on Electron ${runtime.info.versions.electron}.`
              : 'usee'}
          </p>
          <p className="field-note">
            Privacy: usee sends nothing off this computer. There is no account, upload or telemetry;
            recordings stay in Videos\usee, and settings and logs in your app-data folder. The
            privacy policy, PRIVACY.txt, is in usee's installation folder.
          </p>
          <p className="field-note">
            Export uses FFmpeg, licensed under the LGPL 2.1 or later and built from its published
            source without GPL or non-free parts. Its licence ships beside the app.
          </p>
          <div>
            <button type="button" onClick={onShowWelcome}>
              Show the welcome tour
            </button>
          </div>
        </Card>
      </div>
    </div>
  );
}
