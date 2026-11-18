import { useState } from 'react';
import { useStore } from 'zustand';

import { ProjectList } from '../editor/ProjectList';
import type { ProjectStore } from '../editor/project-store';
import { Icon } from '../editor/ui';
import { messageFor } from '../messages';

/** Every recording in the projects folder, newest first, with a filter by name. */
export function RecordingsPage({ store }: { readonly store: ProjectStore }) {
  const recent = useStore(store, (state) => state.recent);
  const [query, setQuery] = useState('');
  const [folderError, setFolderError] = useState<string | null>(null);
  const needle = query.trim().toLocaleLowerCase();
  const shown =
    needle === ''
      ? recent
      : recent.filter((project) => project.title.toLocaleLowerCase().includes(needle));

  const showFolder = async () => {
    setFolderError(null);
    const result = await window.desktop.showProjectsFolder();
    if (!result.ok) {
      setFolderError(messageFor(result.error.userMessageKey));
    }
  };

  return (
    <div className="page-body">
      <header className="page-head">
        <div>
          <h2>Recordings</h2>
          <p className="page-note">
            {recent.length === 0
              ? 'Nothing recorded yet.'
              : `${recent.length} ${recent.length === 1 ? 'recording' : 'recordings'}, newest first.`}
          </p>
        </div>
        <button type="button" className="ghost" onClick={() => void showFolder()}>
          <Icon name="folder" />
          Show folder
        </button>
      </header>
      {folderError !== null && (
        <p className="status status-error" role="alert">
          {folderError}
        </p>
      )}
      <section className="card" aria-label="All recordings">
        {recent.length > 0 && (
          <label className="field search-field">
            <span>Find by name</span>
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
        )}
        <ProjectList
          store={store}
          projects={shown}
          empty={
            recent.length === 0
              ? 'Recordings you make appear here. Start one from Home.'
              : 'No recording has that in its name.'
          }
        />
      </section>
    </div>
  );
}
