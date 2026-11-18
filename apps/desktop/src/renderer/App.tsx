import { useEffect, useState } from 'react';
import { useStore } from 'zustand';

import { EditorView } from './editor/EditorView';
import type { PlaybackStore } from './editor/playback-store';
import type { ProjectStore } from './editor/project-store';
import { HomePage } from './home/HomePage';
import { RecordingsPage } from './library/RecordingsPage';
import { messageFor } from './messages';
import type { RecordingStore } from './recording/recording-store';
import { useRuntimeInfo } from './runtime/use-runtime-info';
import { SettingsPage } from './settings/SettingsPage';
import type { SettingsStore } from './settings/settings-store';
import { MOTION } from './shell/motion';
import { PAGES, Sidebar, type Page } from './shell/Sidebar';
import { INTRO_MS } from './shell/StartupIntro';
import { Welcome } from './welcome/Welcome';

export function App({
  recordingStore,
  projectStore,
  playbackStore,
  settingsStore,
}: {
  readonly recordingStore: RecordingStore;
  readonly projectStore: ProjectStore;
  readonly playbackStore: PlaybackStore;
  readonly settingsStore: SettingsStore;
}) {
  const runtime = useRuntimeInfo();
  const [page, setPage] = useState<Page>('home');
  useEffect(() => recordingStore.getState().initialize(), [recordingStore]);
  useEffect(() => projectStore.getState().initialize(), [projectStore]);

  const project = useStore(projectStore, (state) => state.project);
  const recording = useStore(recordingStore, (state) => state.recording);
  const projectError = useStore(projectStore, (state) => state.error);
  // The welcome tour opens on a first start, once the settings say it has not been seen;
  // after that it opens only from Settings.
  const welcomeSeen = useStore(settingsStore, (state) =>
    state.settings === undefined ? undefined : state.settings.welcome?.seen === true,
  );
  const [welcomeOpen, setWelcomeOpen] = useState<boolean | undefined>(undefined);
  const showWelcome = welcomeOpen ?? welcomeSeen === false;

  // A finished recording opens straight in the editor.
  const completedPath = recording.phase === 'completed' ? recording.projectPath : null;
  useEffect(() => {
    if (completedPath !== null) {
      void projectStore.getState().open(completedPath);
    }
  }, [completedPath, projectStore]);

  // The editor takes the whole window; closing it returns to the page that opened it.
  if (project !== null) {
    return (
      <main className="editor-shell">
        <EditorView
          store={projectStore}
          playback={playbackStore}
          settings={settingsStore}
          backLabel={PAGES.find(({ id }) => id === page)?.label ?? 'Home'}
        />
      </main>
    );
  }

  return (
    <div className="app-frame">
      <Sidebar page={page} onNavigate={setPage} recordingStore={recordingStore} runtime={runtime} />
      <main className="page">
        {projectError !== undefined && (
          <p className="status status-error" role="alert">
            {messageFor(projectError.userMessageKey)} Support reference:{' '}
            {projectError.correlationId}
          </p>
        )}
        {page === 'home' && (
          <HomePage
            recordingStore={recordingStore}
            projectStore={projectStore}
            settings={settingsStore}
            onSeeAll={() => setPage('recordings')}
          />
        )}
        {page === 'recordings' && <RecordingsPage store={projectStore} />}
        {page === 'settings' && (
          <SettingsPage
            settings={settingsStore}
            runtime={runtime}
            onShowWelcome={() => setWelcomeOpen(true)}
          />
        )}
      </main>
      {showWelcome && (
        <Welcome
          settings={settingsStore}
          // Opening with the app, it waits for the startup intro to finish.
          entranceDelayMs={welcomeOpen === undefined && MOTION ? INTRO_MS : 0}
          onClose={() => setWelcomeOpen(false)}
        />
      )}
    </div>
  );
}
