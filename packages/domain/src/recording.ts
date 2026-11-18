import type {
  AssetId,
  CoordinateSpace,
  RecordingSessionId,
  Rectangle,
  TimestampUs,
} from '@usee/contracts';

export interface DisplayRecordingSource {
  readonly kind: 'display';
  readonly displayId: string;
  readonly coordinateSpace: CoordinateSpace;
  readonly bounds: Rectangle;
}

export interface WindowRecordingSource {
  readonly kind: 'window';
  readonly windowId: string;
  readonly coordinateSpace: CoordinateSpace;
}

/** A region is a GPU crop over an approved display capture, not an OS primitive. */
export interface RegionRecordingSource {
  readonly kind: 'region';
  readonly coordinateSpace: CoordinateSpace;
  readonly region: Rectangle;
}

export interface WebcamRecordingSource {
  readonly kind: 'webcam';
  readonly deviceId: string;
}

export type RecordingSource =
  DisplayRecordingSource | RegionRecordingSource | WebcamRecordingSource | WindowRecordingSource;

export interface RecordingSession {
  readonly id: RecordingSessionId;
  readonly startedAtUs: TimestampUs;
  readonly endedAtUs?: TimestampUs;
  readonly sources: readonly RecordingSource[];
  readonly videoAssetIds: readonly AssetId[];
  readonly audioAssetIds: readonly AssetId[];
  readonly interactionAssetId?: AssetId;
}
