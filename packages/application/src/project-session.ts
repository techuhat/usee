import {
  asTimestampUs,
  createAppError,
  err,
  ok,
  type AppError,
  type ClipId,
  type CorrelationId,
  type EffectId,
  type Result,
} from '@usee/contracts';
import {
  applyProjectCommand,
  withAnalysisRun,
  type AnalysisRun,
  type Project,
  type ProjectCommand,
} from '@usee/domain';

import type { ProjectRepositoryPort } from './project-ports';

export type ProjectSaveState = 'saved' | 'saving' | 'failed';

/** What viewers see of the open project. */
export interface ProjectSessionState {
  readonly projectPath: string;
  readonly project: Project;
  /** Grows with every change, so a viewer can drop a snapshot older than one it has. */
  readonly revision: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly saveState: ProjectSaveState;
  /** Why the last save failed, while `saveState` is `failed`. */
  readonly saveError: AppError | null;
}

export interface ProjectSessionDependencies {
  readonly repository: ProjectRepositoryPort;
  readonly createClipId: () => ClipId;
  readonly createEffectId: () => EffectId;
  readonly createCorrelationId: () => CorrelationId;
  readonly now: () => Date;
  /** Undo steps kept; the oldest are dropped first. */
  readonly historyLimit?: number;
}

/**
 * The open project and its command history: while the editor is open, the
 * one authority for project truth (docs/state-management.md). Edits are
 * semantic commands, undo and redo swap whole immutable snapshots, and every
 * change is saved in the background, one save at a time, the latest last.
 */
export class ProjectSession {
  readonly #deps: ProjectSessionDependencies;
  readonly #listeners = new Set<(state: ProjectSessionState | null) => void>();
  #state: ProjectSessionState | null = null;
  #undo: Project[] = [];
  #redo: Project[] = [];
  #saving: Promise<void> | undefined;
  #saveAgain = false;

  constructor(dependencies: ProjectSessionDependencies) {
    this.#deps = dependencies;
  }

  get state(): ProjectSessionState | null {
    return this.#state;
  }

  /** Returns a function that removes the listener. */
  subscribe(listener: (state: ProjectSessionState | null) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Opens a project in place of the current one, which stays open if this fails. */
  async open(projectPath: string): Promise<Result<ProjectSessionState>> {
    await this.flush();
    const opened = await this.#deps.repository.open(projectPath);
    if (!opened.ok) {
      return opened;
    }
    this.#undo = [];
    this.#redo = [];
    const state: ProjectSessionState = {
      projectPath,
      project: opened.value.project,
      revision: 0,
      canUndo: false,
      canRedo: false,
      saveState: 'saved',
      saveError: null,
    };
    this.#publish(state);
    return ok(state);
  }

  /** Saves what is pending, then closes the project. */
  async close(): Promise<void> {
    await this.flush();
    if (this.#state !== null) {
      this.#undo = [];
      this.#redo = [];
      this.#publish(null);
    }
  }

  /** Resolves once every change so far is saved, or has failed to save. */
  async flush(): Promise<void> {
    while (this.#saving !== undefined) {
      await this.#saving;
    }
  }

  /** Saves now, as after a failed save, and reports how it went. */
  async save(): Promise<Result<ProjectSessionState>> {
    if (this.#state === null) {
      return err(this.#error('project.not-open'));
    }
    this.#startSave();
    await this.flush();
    const state = this.#state;
    if (state === null) {
      return err(this.#error('project.not-open'));
    }
    return state.saveError === null ? ok(state) : err(state.saveError);
  }

  edit(command: ProjectCommand): Result<ProjectSessionState> {
    const state = this.#state;
    if (state === null) {
      return err(this.#error('project.not-open'));
    }
    const edited = applyProjectCommand(state.project, command, {
      newClipId: this.#deps.createClipId,
      newEffectId: this.#deps.createEffectId,
    });
    if (!edited.ok) {
      return err(this.#error(`project.${edited.error}`));
    }
    if (edited.value === state.project) {
      return ok(state); // nothing changed: no history step, no save
    }
    this.#undo.push(state.project);
    if (this.#undo.length > (this.#deps.historyLimit ?? 100)) {
      this.#undo.shift();
    }
    this.#redo = [];
    return ok(this.#change(edited.value));
  }

  /**
   * Puts derived analysis runs into the project open at `projectPath`, and
   * into every snapshot of its history, so undo and redo never bring back
   * an older run: they are not an edit, and take no undo step. Dropped when
   * that project is no longer open.
   */
  applyAnalysis(projectPath: string, runs: readonly AnalysisRun[]): void {
    const state = this.#state;
    if (state === null || state.projectPath !== projectPath || runs.length === 0) {
      return;
    }
    const withRuns = (project: Project): Project => ({
      ...project,
      analysisRuns: runs.reduce(withAnalysisRun, project.analysisRuns),
    });
    this.#undo = this.#undo.map(withRuns);
    this.#redo = this.#redo.map(withRuns);
    this.#change(withRuns(state.project));
  }

  undo(): Result<ProjectSessionState> {
    return this.#step(this.#undo, this.#redo);
  }

  redo(): Result<ProjectSessionState> {
    return this.#step(this.#redo, this.#undo);
  }

  #step(from: Project[], to: Project[]): Result<ProjectSessionState> {
    const state = this.#state;
    if (state === null) {
      return err(this.#error('project.not-open'));
    }
    const project = from.pop();
    if (project === undefined) {
      return ok(state);
    }
    to.push(state.project);
    return ok(this.#change(project));
  }

  #change(project: Project): ProjectSessionState {
    const state = this.#state as ProjectSessionState;
    const next: ProjectSessionState = {
      ...state,
      project: { ...project, updatedAtUs: asTimestampUs(this.#deps.now().getTime() * 1000) },
      revision: state.revision + 1,
      canUndo: this.#undo.length > 0,
      canRedo: this.#redo.length > 0,
      saveState: 'saving',
      saveError: null,
    };
    this.#publish(next);
    this.#startSave();
    return next;
  }

  #startSave(): void {
    if (this.#saving !== undefined) {
      this.#saveAgain = true; // the running save picks up the latest project next
      return;
    }
    this.#saving = this.#saveLatest().finally(() => {
      this.#saving = undefined;
      // A change made after the loop's last look, as it finished, is saved now.
      if (this.#saveAgain) {
        this.#startSave();
      }
    });
  }

  async #saveLatest(): Promise<void> {
    do {
      this.#saveAgain = false;
      const state = this.#state;
      if (state === null) {
        return;
      }
      if (state.saveState !== 'saving') {
        this.#publish({ ...state, saveState: 'saving', saveError: null });
      }
      const saved = await this.#deps.repository.save(state.projectPath, state.project);
      const current = this.#state;
      if (current === null || current.projectPath !== state.projectPath) {
        return;
      }
      if (!this.#saveAgain) {
        this.#publish({
          ...current,
          saveState: saved.ok ? 'saved' : 'failed',
          saveError: saved.ok ? null : saved.error,
        });
      }
    } while (this.#saveAgain);
  }

  #publish(state: ProjectSessionState | null): void {
    this.#state = state;
    for (const listener of this.#listeners) {
      listener(state);
    }
  }

  #error(code: `project.${string}`): AppError {
    return createAppError({
      category: 'project',
      code,
      retryable: false,
      userMessageKey: `errors.${code}`,
      correlationId: this.#deps.createCorrelationId(),
    });
  }
}
