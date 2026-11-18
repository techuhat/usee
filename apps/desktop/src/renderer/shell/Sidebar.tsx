import { useStore } from 'zustand';

import { Icon, type IconName } from '../editor/ui';
import { messageFor } from '../messages';
import { formatDuration } from '../recording/format';
import type { RecordingStore } from '../recording/recording-store';
import type { RuntimeInfoState } from '../runtime/use-runtime-info';

export type Page = 'home' | 'recordings' | 'settings';

export const PAGES: readonly {
  readonly id: Page;
  readonly label: string;
  readonly icon: IconName;
}[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'recordings', label: 'Recordings', icon: 'library' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

/** The app's mark: a lens with the tally light that shows it is live. */
function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 28 28" aria-hidden="true" focusable="false">
      <rect x="1.5" y="1.5" width="25" height="25" rx="8" className="brand-plate" />
      <circle cx="14" cy="14" r="6.2" className="brand-lens" />
      <circle cx="14" cy="14" r="2.6" className="brand-tally" />
    </svg>
  );
}

function RuntimeSummary({ state }: { readonly state: RuntimeInfoState }) {
  switch (state.status) {
    case 'loading':
      return <p className="runtime">Connecting…</p>;
    case 'failed':
      return (
        <p className="runtime runtime-error" role="alert">
          {messageFor(state.error.userMessageKey)} Support reference: {state.error.correlationId}
        </p>
      );
    case 'ready':
      return (
        <p className="runtime" data-testid="runtime-summary">
          Version {state.info.applicationVersion}
        </p>
      );
  }
}

/** Navigation between the app's pages, and a recording's state wherever you are. */
export function Sidebar({
  page,
  onNavigate,
  recordingStore,
  runtime,
}: {
  readonly page: Page;
  readonly onNavigate: (page: Page) => void;
  readonly recordingStore: RecordingStore;
  readonly runtime: RuntimeInfoState;
}) {
  const recording = useStore(recordingStore, (state) => state.recording);
  return (
    <nav className="sidebar" aria-label="Main">
      <h1 className="brand">
        <BrandMark />
        usee
      </h1>
      <ul className="nav-list">
        {PAGES.map(({ id, label, icon }) => (
          <li key={id}>
            <button
              type="button"
              className="nav-item"
              aria-current={page === id ? 'page' : undefined}
              onClick={() => onNavigate(id)}
            >
              <Icon name={icon} />
              {label}
            </button>
          </li>
        ))}
      </ul>
      <div className="sidebar-foot">
        {recording.phase === 'recording' && (
          <button
            type="button"
            className="live-chip"
            onClick={() => onNavigate('home')}
            title="Go to the recording"
          >
            <span className="live-dot" aria-hidden="true" />
            Live {formatDuration(recording.metrics.elapsedUs)}
          </button>
        )}
        <RuntimeSummary state={runtime} />
      </div>
    </nav>
  );
}
