import type {
  AssetId,
  PictureAnalysisDto,
  PointerTrackDto,
  ProjectId,
  Result,
} from '@usee/contracts';
import type { Project } from '@usee/domain';

import type { AnalysisInputPort } from './camera-analysis';

export interface OpenedProject {
  readonly project: Project;
  /** The manifest version on disk when it was older and was migrated on open. */
  readonly migratedFrom: number | null;
}

/** An asset's audio peaks, 0-255, `peaksPerSecond` of them per second, base64-encoded. */
export interface WaveformPeaks {
  readonly peaksPerSecond: number;
  readonly peaks: string;
}

export interface ProjectSummary {
  readonly projectPath: string;
  readonly title: string;
  /** The project's thumbnail as a JPEG data URL; only the newest projects carry one. */
  readonly thumbnail?: string;
  /** ISO-8601 time the manifest was last written. */
  readonly modifiedAt: string;
}

/**
 * Project bundles on disk (docs/project-format.md). The filesystem adapter
 * owns migrating on open, atomic saves and the recovery checkpoint.
 */
export interface ProjectRepositoryPort extends AnalysisInputPort {
  /** Bundles in the projects folder, most recently saved first. */
  list(): Promise<Result<readonly ProjectSummary[]>>;
  /** Reads `manifest.json`; an older version is backed up, migrated and written back. */
  open(projectPath: string): Promise<Result<OpenedProject>>;
  /** Replaces the project atomically, keeping the previous manifest as the checkpoint. */
  save(projectPath: string, project: Project): Promise<Result<void>>;
  /** Resolves listed managed media IDs inside their project bundle, for main-process workers only. */
  resolveMediaAssets(
    projectId: ProjectId,
    assetIds: readonly AssetId[],
  ): Promise<Result<Readonly<Record<string, string>>>>;
  /** Reads a pointer stream by managed asset ID, including for a recovered export job. */
  readPointerTrackById(
    projectId: ProjectId,
    streamAssetId: AssetId,
  ): Promise<Result<PointerTrackDto | null>>;
  /** The asset's derived waveform, or null when there is none or it is unreadable. */
  readWaveform(projectPath: string, assetId: string): Promise<Result<WaveformPeaks | null>>;
  /** What the editor found in a recording's picture, or null when it has not read it. */
  readPictureAnalysis(
    projectPath: string,
    assetId: string,
  ): Promise<Result<PictureAnalysisDto | null>>;
  /** Keeps the project's thumbnail, a small JPEG, as derived data. */
  writeThumbnail(projectPath: string, jpeg: Uint8Array): Promise<Result<void>>;
  /** Keeps what the editor found in a recording's picture, as derived data. */
  writePictureChanges(
    projectPath: string,
    assetId: string,
    analysis: PictureAnalysisDto,
    producer: string,
  ): Promise<Result<void>>;
  /**
   * A pointer stream asset in columns for the editor, or null when it is
   * missing or its header is unreadable. `relativePath` comes from the manifest.
   */
  readPointerTrack(
    projectPath: string,
    relativePath: string,
  ): Promise<Result<PointerTrackDto | null>>;
}
