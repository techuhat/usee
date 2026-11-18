import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { REGION_PICKER_HASH } from '@usee/contracts';

import { App } from './App';
import { createPlaybackStore } from './editor/playback-store';
import { createProjectStore } from './editor/project-store';
import { startExportFrameRenderer } from './editor/export-frame-renderer';
import { createRecordingStore } from './recording/recording-store';
import { RegionPicker } from './recording/RegionPicker';
import { createSettingsStore } from './settings/settings-store';
import './styles.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('The renderer root element is missing.');
}

if (window.location.hash === REGION_PICKER_HASH) {
  // The area picker's own window over a display (ADR-009): no stores, no export renderer.
  document.documentElement.classList.add('region-picker-page');
  createRoot(rootElement).render(
    <StrictMode>
      <RegionPicker bridge={window.desktop} />
    </StrictMode>,
  );
} else {
  startApp(rootElement);
}

function startApp(root: HTMLElement): void {
  const recordingStore = createRecordingStore(window.desktop);
  const projectStore = createProjectStore(window.desktop);
  const playbackStore = createPlaybackStore();
  const settingsStore = createSettingsStore(window.desktop);
  // The remembered recording choices are the recording panel's starting point,
  // whether they were made there or in Settings.
  settingsStore.subscribe((state, previous) => {
    const defaults = state.settings?.recording;
    if (defaults !== undefined && defaults !== previous.settings?.recording) {
      const { frameRate, trackPointer, includeCursor } = defaults;
      recordingStore.getState().select({ frameRate, trackPointer, includeCursor });
    }
  });
  void settingsStore.getState().initialize();
  const stopExportRenderer = startExportFrameRenderer(window.desktop);
  window.addEventListener('beforeunload', stopExportRenderer, { once: true });

  createRoot(root).render(
    <StrictMode>
      <App
        recordingStore={recordingStore}
        projectStore={projectStore}
        playbackStore={playbackStore}
        settingsStore={settingsStore}
      />
    </StrictMode>,
  );
}
