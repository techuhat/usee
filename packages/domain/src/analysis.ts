import type { RecordingSessionId } from '@usee/contracts';

import type { GeneratedZoom } from './focus';

/**
 * The generated camera layer, for the whole project (since manifest v4):
 * whether it shows, the scale of its zooms, and the zooms the user turned
 * off. Turning a zoom off, or taking it over as a clip's own zoom, is a
 * manual override; the generated track itself never changes for it.
 */
export interface AutoZoomSettings {
  readonly enabled: boolean;
  readonly scale: number;
  /** IDs of generated zooms turned off. */
  readonly disabled: readonly string[];
  /**
   * How far the generated camera turns toward each action, 0-1: 0 (or
   * absent) keeps it flat (since manifest v9).
   */
  readonly turn3d?: number;
}

export const DEFAULT_AUTO_ZOOM_SETTINGS: AutoZoomSettings = Object.freeze({
  enabled: true,
  scale: 2,
  disabled: Object.freeze([]),
});

/** What made an analysis run, from what: its provenance (docs/project-format.md). */
export interface AnalysisProvenance {
  /** The focus strategy and its version; a new version regenerates the run. */
  readonly strategy: string;
  readonly strategyVersion: number;
  /** The application that ran it, with its version. */
  readonly producer: string;
  /** SHA-256 of the input file, so a changed input regenerates the run. */
  readonly inputSha256: string;
  /** ISO-8601. */
  readonly generatedAt: string;
}

/** A generated camera track for one recording session (Phase 4, focus intelligence). */
export interface CameraAnalysisRun {
  readonly kind: 'camera-track';
  readonly id: string;
  readonly sessionId: RecordingSessionId;
  readonly provenance: AnalysisProvenance;
  /** Session time; each ID is unique in the project. */
  readonly zooms: readonly GeneratedZoom[];
}

export type AnalysisRun = CameraAnalysisRun;

/** The project's runs with `run` in place of the run of the same kind for the same session. */
export function withAnalysisRun(
  runs: readonly AnalysisRun[],
  run: AnalysisRun,
): readonly AnalysisRun[] {
  const others = runs.filter(
    (existing) => !(existing.kind === run.kind && existing.sessionId === run.sessionId),
  );
  return [...others, run];
}

/** The generated zoom with this ID, in any run. */
export function findGeneratedZoom(
  runs: readonly AnalysisRun[],
  zoomId: string,
): GeneratedZoom | undefined {
  for (const run of runs) {
    const zoom = run.zooms.find((candidate) => candidate.id === zoomId);
    if (zoom !== undefined) {
      return zoom;
    }
  }
  return undefined;
}
