import { useStore } from 'zustand';

import type { NewProjectDefaults } from '@usee/contracts';

import { ProjectList } from '../editor/ProjectList';
import type { ProjectStore } from '../editor/project-store';
import { Swatches, Switch } from '../editor/ui';
import { RecordingPanel } from '../recording/RecordingPanel';
import type { RecordingStore } from '../recording/recording-store';
import { RecoveryBanner } from '../recording/RecoveryBanner';
import { canvasForLook, LOOK_SWATCHES, lookOf } from '../settings/looks';
import type { SettingsStore } from '../settings/settings-store';

/** How far a newly turned-on 3D motion turns, as the editor's switch does. */
const DEFAULT_TURN = 0.6;

/** What every new recording starts with: the editor's main looks, one click each. */
function NewRecordingLooks({ settings }: { readonly settings: SettingsStore }) {
  const looks = useStore(settings, (state) => state.settings?.newProjects);
  if (looks === undefined) {
    return null;
  }
  const change = (patch: Partial<NewProjectDefaults>) =>
    void settings.getState().update({ newProjects: { ...looks, ...patch } });
  return (
    <section className="card looks-card" aria-labelledby="looks-title">
      <header className="card-head">
        <h2 id="looks-title">New recordings start with</h2>
        <p className="card-note">Change any of it in the editor. Settings has the rest.</p>
      </header>
      <Switch
        label="Auto zoom on clicks"
        checked={looks.autoZoom}
        onChange={(autoZoom) => change({ autoZoom })}
      />
      <Switch
        label="3D motion toward each action"
        checked={looks.turn3d > 0}
        disabled={!looks.autoZoom}
        onChange={(on) => change({ turn3d: on ? DEFAULT_TURN : 0 })}
      />
      <div className="field">
        <span className="field-label">Background</span>
        <Swatches
          label="Background"
          swatches={LOOK_SWATCHES}
          selected={lookOf(looks.canvas)}
          onPick={(swatch) => change({ canvas: canvasForLook(swatch.id) })}
        />
      </div>
    </section>
  );
}

/** The first page: record, set how new recordings look, and get back to recent ones. */
export function HomePage({
  recordingStore,
  projectStore,
  settings,
  onSeeAll,
}: {
  readonly recordingStore: RecordingStore;
  readonly projectStore: ProjectStore;
  readonly settings: SettingsStore;
  readonly onSeeAll: () => void;
}) {
  const recent = useStore(projectStore, (state) => state.recent);
  const recordingDefaults = useStore(settings, (state) => state.settings?.recording);
  return (
    <div className="home">
      <RecoveryBanner store={recordingStore} />
      <div className="home-top">
        <RecordingPanel
          store={recordingStore}
          countdown={recordingDefaults?.countdown !== false}
          onDefaults={(recording) =>
            void settings.getState().update({
              recording: { ...settings.getState().settings?.recording, ...recording },
            })
          }
        />
        <NewRecordingLooks settings={settings} />
      </div>
      <section className="card recent-card" aria-labelledby="recent-title">
        <header className="card-head card-head-row">
          <h2 id="recent-title">Recent</h2>
          {recent.length > 4 && (
            <button type="button" className="ghost" onClick={onSeeAll}>
              See all
            </button>
          )}
        </header>
        <ProjectList
          store={projectStore}
          projects={recent.slice(0, 4)}
          empty="Recordings you make appear here."
        />
      </section>
    </div>
  );
}
