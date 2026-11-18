import type { AssetId, ClipId, FrameRate, TimelineId, TimestampUs, TrackId } from '@usee/contracts';

import type { Effect } from './effects';
import type { TimeRange } from './time-range';

export interface Clip {
  readonly id: ClipId;
  readonly assetId: AssetId;
  /** The span of the source asset this clip plays. */
  readonly sourceRange: TimeRange;
  readonly timelineStartUs: TimestampUs;
  readonly effects: readonly Effect[];
  /**
   * How fast the clip plays its source: 2 takes half the time on the timeline,
   * 0.5 twice as long. Absent is 1 (since manifest v7).
   */
  readonly speed?: number;
}

export interface TimelineTrack {
  readonly id: TrackId;
  readonly kind: 'audio' | 'effects' | 'video';
  readonly muted: boolean;
  readonly clips: readonly Clip[];
}

export interface Timeline {
  readonly id: TimelineId;
  readonly frameRate: FrameRate;
  readonly tracks: readonly TimelineTrack[];
}
