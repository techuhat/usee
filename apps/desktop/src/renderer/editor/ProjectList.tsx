import { useStore } from 'zustand';

import type { ProjectSummary } from '@usee/contracts';

import type { ProjectStore } from './project-store';
import { Icon } from './ui';

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Projects in the recordings folder, newest first, each with a button to open it. */
export function ProjectList({
  store,
  projects,
  empty,
}: {
  readonly store: ProjectStore;
  readonly projects: readonly ProjectSummary[];
  /** What to say when there is nothing to list. */
  readonly empty: string;
}) {
  const opening = useStore(store, (state) => state.opening);

  if (projects.length === 0) {
    return <p className="empty-note">{empty}</p>;
  }
  return (
    <ul className="project-list" data-testid="project-list">
      {projects.map((project) => (
        <li key={project.projectPath}>
          {project.thumbnail === undefined ? (
            <span className="project-tile" aria-hidden="true">
              <Icon name="library" />
            </span>
          ) : (
            <img className="project-tile project-thumbnail" src={project.thumbnail} alt="" />
          )}
          <span className="project-text">
            <span className="project-title">{project.title}</span>
            <span className="project-date">{DATE_FORMAT.format(new Date(project.modifiedAt))}</span>
          </span>
          <button
            type="button"
            disabled={opening}
            onClick={() => void store.getState().open(project.projectPath)}
          >
            Open
          </button>
        </li>
      ))}
    </ul>
  );
}
