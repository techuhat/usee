import type { AssetId, DurationUs, FrameRate, PixelSize, TimestampUs } from '@usee/contracts';

/**
 * Immutable media metadata. `relativePath` is normalized and confined to the
 * project root; it is validated by the project-format layer before use.
 */
export interface AssetBase {
  readonly id: AssetId;
  readonly createdAtUs: TimestampUs;
  readonly durationUs: DurationUs;
  readonly relativePath: string;
}

/**
 * Media recorded by a session knows where its own time zero falls on the
 * session clock, which its interaction streams use: a merged recording
 * starts at the session's zero, a segment file at the segment's start.
 */
interface RecordedMedia {
  readonly sessionStartUs?: TimestampUs;
}

export interface VideoAsset extends AssetBase, RecordedMedia {
  readonly kind: 'video';
  /**
   * How much older than its timestamp the picture in a frame is, as the
   * recorder measured it (since v10), negative when the picture is shown
   * after its timestamp: its interaction streams are read that much earlier,
   * or later (pointerTimeOrigin). Absent when it was not measured.
   */
  readonly captureLatencyUs?: number;
  readonly dimensions: PixelSize;
  readonly frameRate: FrameRate;
  readonly hasAudio: boolean;
}

export interface AudioAsset extends AssetBase, RecordedMedia {
  readonly kind: 'audio';
  readonly channels: number;
  readonly sampleRateHz: number;
}

/** Pointer and click streams recorded beside the media. */
export interface EventAsset extends AssetBase {
  readonly kind: 'event';
  readonly eventEncoding: 'jsonl' | 'protobuf';
}

export type MediaAsset = AudioAsset | EventAsset | VideoAsset;
