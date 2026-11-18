import type { FrameRate, ProjectId, SchemaVersion, TimestampUs } from '@usee/contracts';

import type { AnalysisRun, AutoZoomSettings } from './analysis';
import type { MediaAsset } from './assets';
import type { CanvasStyle } from './canvas';
import type { CursorSettings } from './effects';
import type { RecordingSession } from './recording';
import type { Timeline } from './timeline';

export interface ProjectSettings {
  readonly defaultFrameRate: FrameRate;
  readonly previewQuality: 'draft' | 'full';
  readonly colorSpace: 'sdr' | 'hdr';
  /** Since manifest v2. */
  readonly cursor: CursorSettings;
  /** Since manifest v4. */
  readonly autoZoom: AutoZoomSettings;
  /** The output canvas: background, padding, corners, shadow, aspect. Since manifest v6. */
  readonly canvas: CanvasStyle;
}

/** The canonical, persisted project truth. UI state never lives here. */
export interface Project {
  readonly id: ProjectId;
  readonly schemaVersion: SchemaVersion;
  readonly title: string;
  readonly createdAtUs: TimestampUs;
  readonly updatedAtUs: TimestampUs;
  readonly assets: readonly MediaAsset[];
  readonly recordingSessions: readonly RecordingSession[];
  readonly timeline: Timeline;
  /** Generated tracks with their provenance (since manifest v4); derived, so never undone. */
  readonly analysisRuns: readonly AnalysisRun[];
  readonly settings: ProjectSettings;
}
