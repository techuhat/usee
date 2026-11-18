import type {
  AssetId,
  ClipId,
  FrameRate,
  JobId,
  PixelSize,
  ProjectId,
  RecordingSessionId,
  TimestampUs,
  TrackId,
} from '@usee/contracts';

import type { AutoZoomSettings, AnalysisRun } from './analysis';
import type { AudioAsset, EventAsset, VideoAsset } from './assets';
import { outputAspect, type CanvasStyle } from './canvas';
import type { CursorSettings, Effect } from './effects';

/** Render-job lifecycle from docs/rendering-pipeline.md. */
export type ExportJobState =
  | 'queued'
  | 'preparing'
  | 'rendering'
  | 'validating'
  | 'publishing'
  | 'succeeded'
  | 'canceled'
  | 'failed';

export type ExportPresetId =
  'mp4-h264-1080p30' | 'mp4-h264-1080p60' | 'mp4-h264-1440p30' | 'mp4-h264-4k30';

/** A preset names an approved output intent, never raw encoder flags. */
export interface ExportPreset {
  readonly id: ExportPresetId;
  readonly container: 'mp4' | 'webm';
  readonly codec: 'h264' | 'h265' | 'vp9';
  readonly dimensions: PixelSize;
  readonly frameRate: FrameRate;
  readonly videoBitrateKbps: number;
  readonly audioCodec: 'aac' | 'opus';
  readonly audioBitrateKbps: number;
  readonly audioSampleRateHz: number;
  readonly hardwarePreference: 'prefer-hardware' | 'software-only';
}

export const EXPORT_PRESETS: Readonly<Record<ExportPresetId, ExportPreset>> = Object.freeze({
  'mp4-h264-1080p30': Object.freeze({
    id: 'mp4-h264-1080p30',
    container: 'mp4',
    codec: 'h264',
    dimensions: Object.freeze({ width: 1920, height: 1080 }),
    frameRate: Object.freeze({ numerator: 30, denominator: 1 }),
    videoBitrateKbps: 8_000,
    audioCodec: 'aac',
    audioBitrateKbps: 192,
    audioSampleRateHz: 48_000,
    hardwarePreference: 'prefer-hardware',
  }),
  'mp4-h264-1080p60': Object.freeze({
    id: 'mp4-h264-1080p60',
    container: 'mp4',
    codec: 'h264',
    dimensions: Object.freeze({ width: 1920, height: 1080 }),
    frameRate: Object.freeze({ numerator: 60, denominator: 1 }),
    videoBitrateKbps: 12_400,
    audioCodec: 'aac',
    audioBitrateKbps: 192,
    audioSampleRateHz: 48_000,
    hardwarePreference: 'prefer-hardware',
  }),
  'mp4-h264-1440p30': Object.freeze({
    id: 'mp4-h264-1440p30',
    container: 'mp4',
    codec: 'h264',
    dimensions: Object.freeze({ width: 2560, height: 1440 }),
    frameRate: Object.freeze({ numerator: 30, denominator: 1 }),
    videoBitrateKbps: 16_000,
    audioCodec: 'aac',
    audioBitrateKbps: 192,
    audioSampleRateHz: 48_000,
    hardwarePreference: 'prefer-hardware',
  }),
  'mp4-h264-4k30': Object.freeze({
    id: 'mp4-h264-4k30',
    container: 'mp4',
    codec: 'h264',
    dimensions: Object.freeze({ width: 3840, height: 2160 }),
    frameRate: Object.freeze({ numerator: 30, denominator: 1 }),
    videoBitrateKbps: 35_000,
    audioCodec: 'aac',
    audioBitrateKbps: 192,
    audioSampleRateHz: 48_000,
    hardwarePreference: 'prefer-hardware',
  }),
} satisfies Readonly<Record<ExportPresetId, ExportPreset>>);

/** Fits the project's chosen canvas shape inside a preset's maximum dimensions. */
export function exportDimensions(
  preset: ExportPreset,
  canvas: CanvasStyle,
  sourceAspect: number,
): PixelSize {
  const aspect = outputAspect(canvas, sourceAspect);
  const scale = Math.min(preset.dimensions.width / aspect, preset.dimensions.height);
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  return { width: even(aspect * scale), height: even(scale) };
}

export type RenderAsset =
  | Pick<VideoAsset, 'id' | 'kind' | 'durationUs' | 'dimensions' | 'frameRate' | 'hasAudio'>
  | Pick<AudioAsset, 'id' | 'kind' | 'durationUs' | 'channels' | 'sampleRateHz'>
  | Pick<EventAsset, 'id' | 'kind' | 'durationUs' | 'eventEncoding'>;

export interface RenderClip {
  readonly id: ClipId;
  readonly assetId: AssetId;
  readonly sourceStartUs: number;
  readonly sourceDurationUs: number;
  readonly timelineStartUs: number;
  readonly timelineDurationUs: number;
  readonly speed: number;
  readonly effects: readonly Effect[];
  readonly pointer: {
    readonly streamAssetId: AssetId;
    readonly sessionId: RecordingSessionId;
    readonly sessionStartUs: number;
    readonly captureLatencyUs?: number;
  } | null;
}

export interface RenderTrack {
  readonly id: TrackId;
  readonly kind: 'audio' | 'effects' | 'video';
  readonly muted: boolean;
  readonly clips: readonly RenderClip[];
}

/**
 * Versioned semantic description of one immutable project revision. It has
 * asset IDs, never filesystem paths or media command strings.
 */
export interface RenderPlan {
  readonly planVersion: 1;
  readonly projectId: ProjectId;
  readonly projectUpdatedAtUs: TimestampUs;
  readonly durationUs: number;
  readonly frameRate: FrameRate;
  readonly preset: ExportPreset;
  readonly assets: readonly RenderAsset[];
  readonly tracks: readonly RenderTrack[];
  readonly analysisRuns: readonly AnalysisRun[];
  readonly canvas: CanvasStyle;
  readonly cursor: CursorSettings;
  readonly autoZoom: AutoZoomSettings;
}

export interface ExportJob {
  readonly id: JobId;
  readonly projectId: ProjectId;
  readonly state: ExportJobState;
  readonly preset: ExportPreset;
  readonly destinationPath: string;
  readonly createdAtUs: TimestampUs;
}

export interface RenderJob {
  readonly id: JobId;
  readonly exportJobId: JobId;
  readonly state: ExportJobState;
  /** Fraction complete in [0, 1]. */
  readonly progress: number;
  readonly createdAtUs: TimestampUs;
}
