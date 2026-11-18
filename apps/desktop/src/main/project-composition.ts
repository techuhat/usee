import { createHash, randomUUID } from 'node:crypto';

import { createProjectRepository } from '@usee/adapter-project-fs';
import {
  pointerFocusStrategy,
  ProjectSession,
  staleCameraRuns,
  toProjectSnapshot,
  type FocusStrategy,
} from '@usee/application';
import {
  asClipId,
  asCorrelationId,
  asEffectId,
  createAppError,
  err,
  ok,
  type PictureAnalysisDto,
  type PointerTrackDto,
  type AssetId,
  type ProjectId,
  type ProjectSnapshot,
  type ProjectSummary,
  type Result,
  type ProjectCommandRequest,
  type Waveform,
} from '@usee/contracts';

import type { Logger } from './logging/logger';
import { ProjectMedia } from './project/project-media';
import type { Project } from '@usee/domain';

export interface Projects {
  readonly media: ProjectMedia;
  list(): Promise<Result<readonly ProjectSummary[]>>;
  open(projectPath: string): Promise<Result<ProjectSnapshot>>;
  current(): ProjectSnapshot | null;
  currentProject(): Project | null;
  close(): Promise<Result<null>>;
  edit(command: ProjectCommandRequest): Result<ProjectSnapshot>;
  undo(): Result<ProjectSnapshot>;
  redo(): Result<ProjectSnapshot>;
  save(): Promise<Result<ProjectSnapshot>>;
  waveform(assetId: string): Promise<Result<Waveform | null>>;
  pointerTrack(assetId: string): Promise<Result<PointerTrackDto | null>>;
  /** Plans the open project's automatic camera again, as when the focus settings change. */
  reanalyse(): void;
  /** Keeps a small JPEG of the open project for the project list. */
  saveThumbnail(jpeg: Uint8Array): Promise<Result<null>>;
  /** What the editor found in a recording's picture, or null when it has not read it. */
  pictureChanges(assetId: string): Promise<Result<PictureAnalysisDto | null>>;
  /** Keeps what the editor found in a video asset's picture, then plans the camera again. */
  savePictureChanges(assetId: string, analysis: PictureAnalysisDto): Promise<Result<null>>;
  resolveMediaAssets(
    projectId: ProjectId,
    assetIds: readonly AssetId[],
  ): Promise<Result<Readonly<Record<string, string>>>>;
  readPointerTracks(
    projectId: ProjectId,
    streamIds: readonly AssetId[],
  ): Promise<Result<Readonly<Record<string, PointerTrackDto | null>>>>;
  acquireMediaLease(
    projectId: ProjectId,
    assetIds: readonly AssetId[],
  ): Promise<
    Result<{
      readonly mediaUrls: Readonly<Record<string, string>>;
      readonly release: () => void;
    }>
  >;
  /** Returns a function that removes the listener. */
  subscribe(listener: (snapshot: ProjectSnapshot | null) => void): () => void;
}

/** Only a video asset of the project has a picture to read. */
function isVideoAsset(project: Project, assetId: string): boolean {
  return project.assets.some((asset) => asset.id === assetId && asset.kind === 'video');
}

/**
 * Wires the project session to the project files and the media server, and
 * runs focus analysis for each project as it opens. `producer` names this
 * build in the provenance of what it generates.
 */
export function composeProjects(
  projectsRoot: string,
  logger: Logger,
  producer: string,
  /** How the automatic camera finds where to look, as the settings say now. */
  focusStrategy: () => FocusStrategy = () => pointerFocusStrategy,
): Projects {
  const createCorrelationId = () => asCorrelationId(randomUUID());
  const repository = createProjectRepository({ projectsRoot, createCorrelationId });
  const session = new ProjectSession({
    repository,
    createClipId: () => asClipId(randomUUID()),
    createEffectId: () => asEffectId(randomUUID()),
    createCorrelationId,
    now: () => new Date(),
  });
  const media = new ProjectMedia();
  // Media is published once per opened project, so its URLs stay stable while it is open.
  let mediaProject: string | null = null;

  const snapshot = (): ProjectSnapshot | null => {
    const state = session.state;
    return state === null ? null : toProjectSnapshot(state, (id) => media.urlFor(id));
  };
  const toResult = (result: Result<unknown>): Result<ProjectSnapshot> => {
    if (!result.ok) {
      return result;
    }
    const current = snapshot();
    return current !== null
      ? ok(current)
      : err(
          createAppError({
            category: 'project',
            code: 'project.not-open',
            retryable: false,
            userMessageKey: 'errors.project.not-open',
            correlationId: createCorrelationId(),
          }),
        );
  };

  /**
   * Generates the camera tracks the project at `projectPath` lacks or holds out
   * of date, after it opens. Click-based focus takes milliseconds, so it runs
   * here; the session drops the result if another project opened meanwhile.
   */
  const analyseCamera = async (projectPath: string): Promise<void> => {
    const state = session.state;
    if (state === null || state.projectPath !== projectPath) {
      return;
    }
    const startedAt = Date.now();
    const runs = await staleCameraRuns(state.project, projectPath, repository, {
      strategy: focusStrategy(),
      producer,
      now: () => new Date(),
      hashInputs: (hashes) => createHash('sha256').update(hashes.join(':')).digest('hex'),
    });
    session.applyAnalysis(projectPath, runs);
    if (runs.length > 0) {
      logger.log('INFO', 'project.camera.generated', 'desktop.project', {
        sessions: runs.length,
        zooms: runs.reduce((count, run) => count + run.zooms.length, 0),
        durationMs: Date.now() - startedAt,
      });
    }
  };

  session.subscribe((state) => {
    if ((state?.projectPath ?? null) !== mediaProject) {
      if (state === null) {
        media.clear();
      } else {
        media.publish(
          state.projectPath,
          state.project.assets.filter((asset) => asset.kind !== 'event'),
        );
      }
      mediaProject = state?.projectPath ?? null;
    }
    if (state?.saveState === 'failed' && state.saveError !== null) {
      logger.log('ERROR', 'project.save.failed', 'desktop.project', {
        code: state.saveError.code,
        correlationId: state.saveError.correlationId,
      });
    }
  });

  return {
    media,
    list: () => repository.list(),
    async open(projectPath) {
      const opened = await session.open(projectPath);
      if (!opened.ok) {
        logger.log('WARN', 'project.open.failed', 'desktop.project', {
          code: opened.error.code,
        });
        return opened;
      }
      logger.log('INFO', 'project.opened', 'desktop.project', {
        assets: opened.value.project.assets.length,
        tracks: opened.value.project.timeline.tracks.length,
      });
      analyseCamera(projectPath).catch(() => {
        logger.log('WARN', 'project.camera.failed', 'desktop.project', {});
      });
      return toResult(opened);
    },
    current: snapshot,
    currentProject: () => session.state?.project ?? null,
    async saveThumbnail(jpeg) {
      const state = session.state;
      if (state === null) {
        return ok(null);
      }
      const written = await repository.writeThumbnail(state.projectPath, jpeg);
      return written.ok ? ok(null) : written;
    },
    reanalyse() {
      const state = session.state;
      if (state !== null) {
        analyseCamera(state.projectPath).catch(() => {
          logger.log('WARN', 'project.camera.failed', 'desktop.project', {});
        });
      }
    },
    async pictureChanges(assetId) {
      const state = session.state;
      return state === null || !isVideoAsset(state.project, assetId)
        ? ok(null)
        : repository.readPictureAnalysis(state.projectPath, assetId);
    },
    async savePictureChanges(assetId, analysis) {
      const state = session.state;
      if (state === null || !isVideoAsset(state.project, assetId)) {
        return err(
          createAppError({
            category: 'project',
            code: 'project.asset-not-found',
            retryable: false,
            userMessageKey: 'errors.project.asset-not-found',
            correlationId: createCorrelationId(),
          }),
        );
      }
      const written = await repository.writePictureChanges(
        state.projectPath,
        assetId,
        analysis,
        producer,
      );
      if (!written.ok) {
        return written;
      }
      logger.log('INFO', 'project.picture.analysed', 'desktop.project', {
        changes: analysis.changes.length,
      });
      await analyseCamera(state.projectPath);
      return ok(null);
    },
    resolveMediaAssets: (projectId, assetIds) => repository.resolveMediaAssets(projectId, assetIds),
    async readPointerTracks(projectId, streamIds) {
      const tracks = await Promise.all(
        [...new Set(streamIds)].map(
          async (streamId) =>
            [streamId, await repository.readPointerTrackById(projectId, streamId)] as const,
        ),
      );
      const failed = tracks.find(([, result]) => !result.ok);
      return failed !== undefined && !failed[1].ok
        ? failed[1]
        : ok(
            Object.fromEntries(
              tracks.map(([streamId, result]) => [streamId, result.ok ? result.value : null]),
            ),
          );
    },
    async acquireMediaLease(projectId, assetIds) {
      const resolved = await repository.resolveMediaAssets(projectId, assetIds);
      if (!resolved.ok) {
        return resolved;
      }
      const lease = media.leaseAssets(resolved.value);
      const mediaUrls = Object.fromEntries(
        assetIds.flatMap((assetId) => {
          const url = lease.urlFor(assetId);
          return url === undefined ? [] : [[assetId, url]];
        }),
      );
      if (assetIds.some((assetId) => mediaUrls[assetId] === undefined)) {
        lease.release();
        return err(
          createAppError({
            category: 'project',
            code: 'project.asset-not-found',
            retryable: false,
            userMessageKey: 'errors.project.asset-not-found',
            correlationId: createCorrelationId(),
          }),
        );
      }
      return ok({ mediaUrls, release: lease.release });
    },
    async close() {
      await session.close();
      return ok(null);
    },
    edit: (command) => toResult(session.edit(command)),
    undo: () => toResult(session.undo()),
    redo: () => toResult(session.redo()),
    save: async () => toResult(await session.save()),
    async waveform(assetId) {
      const state = session.state;
      return state === null ? ok(null) : repository.readWaveform(state.projectPath, assetId);
    },
    async pointerTrack(assetId) {
      const state = session.state;
      // Only an event asset of the open project; its path comes from the manifest.
      const asset = state?.project.assets.find(
        (candidate) => candidate.id === assetId && candidate.kind === 'event',
      );
      return state === null || asset === undefined
        ? ok(null)
        : repository.readPointerTrack(state.projectPath, asset.relativePath);
    },
    subscribe(listener) {
      return session.subscribe(() => listener(snapshot()));
    },
  };
}
