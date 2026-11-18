import type { Result } from '@usee/contracts';
import {
  clickFocusCandidates,
  pictureFocusCandidates,
  planCameraTrack,
  pointerTrackFromStream,
  restFocusCandidates,
  type CameraAnalysisRun,
  type FocusCandidate,
  type PictureChange,
  type PointerStream,
  type PointerTrack,
  type Project,
} from '@usee/domain';

/** What a focus strategy sees of one recording session. */
export interface FocusContext {
  readonly pointer: PointerTrack;
  /** Session time the recording ends at. */
  readonly sessionEndUs: number;
  /**
   * Where the session's picture changed, in session time: empty unless the
   * strategy reads the picture and the editor has read the recordings'.
   */
  readonly pictureChanges: readonly PictureChange[];
}

/**
 * One way of finding where to look (docs/module-boundaries.md, "Auto-zoom
 * plug-in seam"). The camera planner turns any strategy's candidates into
 * the same generated track, so the editor never branches on the strategy.
 */
export interface FocusStrategy {
  readonly id: string;
  /** Covers the strategy and the camera planner: a new version regenerates every run. */
  readonly version: number;
  /** It reads where the picture changed, so those changes are part of its input. */
  readonly readsPicture?: boolean;
  analyze(context: FocusContext): readonly FocusCandidate[];
}

/** Focus on every click: cheap enough to run in the main process as a project opens. */
export const clickFocusStrategy: FocusStrategy = {
  id: 'click-focus',
  version: 2,
  analyze: ({ pointer }) => clickFocusCandidates(pointer),
};

/**
 * Focus on every click and on where the pointer rests (Phase 6), the
 * default: as cheap as clicks alone.
 */
export const pointerFocusStrategy: FocusStrategy = {
  id: 'pointer-focus',
  version: 1,
  analyze: ({ pointer, sessionEndUs }) =>
    [...clickFocusCandidates(pointer), ...restFocusCandidates(pointer, sessionEndUs)].sort(
      (first, second) => first.timeUs - second.timeUs,
    ),
};

/**
 * Focus on clicks, rests and where the picture changes (Phase 6): the
 * pointer focus plus each place a menu, a dialog or typing changed the
 * picture, as the editor found it. Chosen in the settings.
 */
export const pointerPictureFocusStrategy: FocusStrategy = {
  id: 'pointer-picture-focus',
  version: 1,
  readsPicture: true,
  analyze: ({ pointer, sessionEndUs, pictureChanges }) =>
    [
      ...clickFocusCandidates(pointer),
      ...restFocusCandidates(pointer, sessionEndUs),
      ...pictureFocusCandidates(pictureChanges),
    ].sort((first, second) => first.timeUs - second.timeUs),
};

/** A session's pointer stream, decoded, and the SHA-256 of its file. */
export interface PointerStreamInput {
  readonly stream: PointerStream;
  readonly sha256: string;
}

/** Where a recording's picture changed, in its own time, and the SHA-256 of the file. */
export interface PictureChangesInput {
  readonly changes: readonly PictureChange[];
  readonly sha256: string;
}

export interface AnalysisInputPort {
  /** The decoded stream, or null when it is missing or unreadable. */
  readPointerStream(
    projectPath: string,
    relativePath: string,
  ): Promise<Result<PointerStreamInput | null>>;
  /** A recording's picture changes, or null until the editor has read its picture. */
  readPictureChanges?(
    projectPath: string,
    assetId: string,
  ): Promise<Result<PictureChangesInput | null>>;
}

export interface CameraAnalysisOptions {
  readonly strategy?: FocusStrategy;
  /**
   * One SHA-256 for several inputs, so a run's provenance names everything a
   * strategy that reads the picture saw (the pointer stream and each picture's changes).
   */
  readonly hashInputs?: (hashes: readonly string[]) => string;
  /** The application that runs the analysis, with its version: provenance. */
  readonly producer: string;
  readonly now: () => Date;
  /** Stops before the next session once aborted (an AbortSignal will do). */
  readonly signal?: { readonly aborted: boolean };
}

/**
 * The generated camera tracks `project` is missing or holds out of date: one
 * per recording session with a pointer stream. A run is current while its
 * strategy, the strategy's version and its input's hash are unchanged, and is
 * not made again. Generated zoom IDs start with the session's, so they are
 * unique in the project.
 */
export async function staleCameraRuns(
  project: Project,
  projectPath: string,
  input: AnalysisInputPort,
  options: CameraAnalysisOptions,
): Promise<CameraAnalysisRun[]> {
  const strategy = options.strategy ?? pointerFocusStrategy;
  const runs: CameraAnalysisRun[] = [];
  /** The picture changes of a session's recordings, moved onto the session clock. */
  const sessionPictures = async (sessionId: string) => {
    const session = project.recordingSessions.find((candidate) => candidate.id === sessionId);
    const pictures: { readonly changes: readonly PictureChange[]; readonly sha256: string }[] = [];
    for (const assetId of [...(session?.videoAssetIds ?? [])].sort()) {
      const asset = project.assets.find((candidate) => candidate.id === assetId);
      const read = await input.readPictureChanges?.(projectPath, assetId);
      if (asset?.kind !== 'video' || read === undefined || !read.ok || read.value === null) {
        continue;
      }
      // A picture change shows the screen as it was one capture latency before its frame time.
      const startUs = (asset.sessionStartUs ?? 0) - (asset.captureLatencyUs ?? 0);
      pictures.push({
        sha256: read.value.sha256,
        changes: read.value.changes.map((change) => ({
          ...change,
          timeUs: change.timeUs + startUs,
        })),
      });
    }
    return pictures;
  };
  for (const session of project.recordingSessions) {
    if (options.signal?.aborted === true) {
      break;
    }
    const asset = project.assets.find(
      (candidate) => candidate.id === session.interactionAssetId && candidate.kind === 'event',
    );
    if (asset === undefined) {
      continue;
    }
    const read = await input.readPointerStream(projectPath, asset.relativePath);
    if (!read.ok || read.value === null) {
      continue; // no stream to analyse: the session gets no generated camera
    }
    const { stream } = read.value;
    const pictures = strategy.readsPicture === true ? await sessionPictures(session.id) : [];
    const sha256 =
      pictures.length === 0 || options.hashInputs === undefined
        ? read.value.sha256
        : options.hashInputs([read.value.sha256, ...pictures.map((picture) => picture.sha256)]);
    const existing = project.analysisRuns.find(
      (run) => run.kind === 'camera-track' && run.sessionId === session.id,
    );
    if (
      existing?.provenance.strategy === strategy.id &&
      existing.provenance.strategyVersion === strategy.version &&
      existing.provenance.inputSha256 === sha256
    ) {
      continue;
    }
    const sessionEndUs = session.endedAtUs ?? asset.durationUs;
    const candidates = strategy.analyze({
      pointer: pointerTrackFromStream(stream),
      sessionEndUs,
      pictureChanges: pictures.flatMap((picture) => picture.changes),
    });
    runs.push({
      kind: 'camera-track',
      id: `${session.id}-camera`,
      sessionId: session.id,
      provenance: {
        strategy: strategy.id,
        strategyVersion: strategy.version,
        producer: options.producer,
        inputSha256: sha256,
        generatedAt: options.now().toISOString(),
      },
      zooms: planCameraTrack(candidates, sessionEndUs).map((zoom) => ({
        ...zoom,
        id: `${session.id}-${zoom.id}`,
      })),
    });
  }
  return runs;
}
