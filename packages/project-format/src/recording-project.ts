import {
  asAssetId,
  asClipId,
  asDurationUs,
  asSchemaVersion,
  asTimelineId,
  asTimestampUs,
  asTrackId,
  MERGED_RECORDING_FILE_NAME,
  type FrameRate,
  type HostSegment,
  type JsonValue,
  type ProjectId,
  type RecordingSessionId,
  type Rectangle,
} from '@usee/contracts';
import {
  DEFAULT_AUTO_ZOOM_SETTINGS,
  DEFAULT_CANVAS_STYLE,
  DEFAULT_CURSOR_SETTINGS,
  type AudioAsset,
  type AutoZoomSettings,
  type CanvasStyle,
  type Clip,
  type EventAsset,
  type MediaAsset,
  type RecordingSource,
  type TimelineTrack,
  type VideoAsset,
} from '@usee/domain';

import { PROJECT_FORMAT_VERSION } from './format-version';
import type { ProjectManifest } from './manifest';
import { pointerStreamPath } from './pointer-stream';

/** How a recording's media arrives in the bundle. */
export type RecordingMedia =
  /** One MP4 holding the video and, when recorded, the audio. */
  | { readonly kind: 'merged'; readonly durationUs: number; readonly hasAudio: boolean }
  /** One file per segment: Phase 1 imports, and the fallback when a merge fails. */
  | { readonly kind: 'segments'; readonly segments: readonly HostSegment[] };

/**
 * What a session recorded: a display, one window named by its ID alone, or a
 * region of a display in its pixels (ADR-009).
 */
export type RecordedSource =
  | { readonly kind: 'display'; readonly displayId: string }
  | { readonly kind: 'window'; readonly windowId: string }
  | { readonly kind: 'region'; readonly region: Rectangle };

export interface RecordingProjectInput {
  readonly projectId: ProjectId;
  readonly title: string;
  /** Wall-clock creation time, microseconds since the Unix epoch. */
  readonly createdAtUs: number;
  readonly sessionId: RecordingSessionId;
  readonly source: RecordedSource;
  readonly video: { readonly width: number; readonly height: number };
  readonly frameRate: FrameRate;
  readonly audio: { readonly sampleRateHz: number; readonly channels: number } | null;
  readonly media: RecordingMedia;
  /** Whether the session's pointer stream was imported (pointer-stream.ts). */
  readonly hasPointer: boolean;
  /** How much older than its timestamp a picture is, as the host measured it; absent when unknown. */
  readonly captureLatencyUs?: number;
  readonly metadata: Readonly<Record<string, JsonValue>>;
  /** How the project starts, from the user's settings; the built-in defaults without. */
  readonly looks?: RecordingProjectLooks;
}

/** The project-wide looks a new recording can start with. */
export interface RecordingProjectLooks {
  readonly autoZoom: AutoZoomSettings;
  readonly canvas: CanvasStyle;
}

function recordingSource(input: RecordingProjectInput): RecordingSource {
  switch (input.source.kind) {
    case 'display':
      return {
        kind: 'display',
        displayId: input.source.displayId,
        coordinateSpace: 'capture',
        bounds: { x: 0, y: 0, width: input.video.width, height: input.video.height },
      };
    case 'window':
      return { kind: 'window', windowId: input.source.windowId, coordinateSpace: 'capture' };
    case 'region':
      return { kind: 'region', coordinateSpace: 'capture', region: input.source.region };
  }
}

/** Bundle-relative directory that holds one session's original media. */
export function sessionMediaDirectory(sessionId: string): string {
  return `media/originals/${sessionId}`;
}

/** The asset ID of a session's merged recording. */
export function recordingAssetId(sessionId: string): string {
  return `${sessionId}-recording`;
}

/**
 * The manifest for a project made from one recording. A merged recording is
 * one video asset (its audio inside) and one clip; segments become an asset
 * and a clip each, on a video and an audio track that tile the session clock.
 */
export function createRecordingProject(input: RecordingProjectInput): ProjectManifest {
  const id = (suffix: string) => `${input.sessionId}-${suffix}`;
  const createdAtUs = asTimestampUs(input.createdAtUs);
  const layout =
    input.media.kind === 'merged'
      ? mergedLayout(input, input.media)
      : segmentLayout(input, input.media.segments);
  const { tracks, durationUs } = layout;
  const pointer: EventAsset | undefined = input.hasPointer
    ? {
        id: asAssetId(id('pointer')),
        kind: 'event',
        createdAtUs,
        durationUs: asDurationUs(durationUs),
        relativePath: pointerStreamPath(input.sessionId),
        eventEncoding: 'jsonl',
      }
    : undefined;
  const assets = pointer === undefined ? layout.assets : [...layout.assets, pointer];

  return {
    manifestVersion: asSchemaVersion(PROJECT_FORMAT_VERSION),
    project: {
      id: input.projectId,
      schemaVersion: asSchemaVersion(1),
      title: input.title,
      createdAtUs,
      updatedAtUs: createdAtUs,
      assets,
      recordingSessions: [
        {
          id: input.sessionId,
          startedAtUs: asTimestampUs(0),
          endedAtUs: asTimestampUs(durationUs),
          sources: [recordingSource(input)],
          videoAssetIds: assets.filter((a) => a.kind === 'video').map((a) => a.id),
          audioAssetIds: assets.filter((a) => a.kind === 'audio').map((a) => a.id),
          ...(pointer === undefined ? {} : { interactionAssetId: pointer.id }),
        },
      ],
      timeline: { id: asTimelineId(id('timeline')), frameRate: input.frameRate, tracks },
      analysisRuns: [],
      settings: {
        defaultFrameRate: input.frameRate,
        previewQuality: 'full',
        colorSpace: 'sdr',
        cursor: DEFAULT_CURSOR_SETTINGS,
        autoZoom: input.looks?.autoZoom ?? DEFAULT_AUTO_ZOOM_SETTINGS,
        canvas: input.looks?.canvas ?? DEFAULT_CANVAS_STYLE,
      },
    },
    managedAssetPaths: Object.fromEntries(assets.map((asset) => [asset.id, asset.relativePath])),
    metadata: input.metadata,
  };
}

interface Layout {
  readonly assets: readonly MediaAsset[];
  readonly tracks: readonly TimelineTrack[];
  readonly durationUs: number;
}

/** The video asset field for the measured capture latency, when there is one. */
function latencyOf(input: RecordingProjectInput): { readonly captureLatencyUs?: number } {
  return input.captureLatencyUs === undefined ? {} : { captureLatencyUs: input.captureLatencyUs };
}

function mergedLayout(
  input: RecordingProjectInput,
  media: Extract<RecordingMedia, { kind: 'merged' }>,
): Layout {
  const asset: VideoAsset = {
    id: asAssetId(recordingAssetId(input.sessionId)),
    kind: 'video',
    createdAtUs: asTimestampUs(input.createdAtUs),
    durationUs: asDurationUs(media.durationUs),
    relativePath: `${sessionMediaDirectory(input.sessionId)}/${MERGED_RECORDING_FILE_NAME}`,
    dimensions: { width: input.video.width, height: input.video.height },
    frameRate: input.frameRate,
    hasAudio: media.hasAudio,
    // The merge puts every sample at its session time.
    sessionStartUs: asTimestampUs(0),
    ...latencyOf(input),
  };
  const clip: Clip = {
    id: asClipId(`${input.sessionId}-clip-recording`),
    assetId: asset.id,
    sourceRange: { startUs: asTimestampUs(0), durationUs: asset.durationUs },
    timelineStartUs: asTimestampUs(0),
    effects: [],
  };
  return {
    assets: [asset],
    tracks: [
      {
        id: asTrackId(`${input.sessionId}-track-video`),
        kind: 'video',
        muted: false,
        clips: [clip],
      },
    ],
    durationUs: media.durationUs,
  };
}

function segmentLayout(input: RecordingProjectInput, segments: readonly HostSegment[]): Layout {
  const createdAtUs = asTimestampUs(input.createdAtUs);
  const id = (suffix: string) => `${input.sessionId}-${suffix}`;
  const assets: MediaAsset[] = [];
  const videoClips: Clip[] = [];
  const audioClips: Clip[] = [];

  for (const segment of segments) {
    const ordinal = String(segment.index).padStart(5, '0');
    const relativePath = `${sessionMediaDirectory(input.sessionId)}/${segment.fileName}`;
    const durationUs = asDurationUs(segment.durationUs);
    const base = {
      createdAtUs,
      durationUs,
      relativePath,
      sessionStartUs: asTimestampUs(segment.startUs),
    };

    if (segment.stream === 'video') {
      const asset: VideoAsset = {
        ...base,
        id: asAssetId(id(`video-${ordinal}`)),
        kind: 'video',
        dimensions: { width: input.video.width, height: input.video.height },
        frameRate: input.frameRate,
        hasAudio: false,
        ...latencyOf(input),
      };
      assets.push(asset);
      videoClips.push(clipFor(asset, segment, id(`clip-video-${ordinal}`)));
    } else if (input.audio !== null) {
      const asset: AudioAsset = {
        ...base,
        id: asAssetId(id(`audio-${ordinal}`)),
        kind: 'audio',
        channels: input.audio.channels,
        sampleRateHz: input.audio.sampleRateHz,
      };
      assets.push(asset);
      audioClips.push(clipFor(asset, segment, id(`clip-audio-${ordinal}`)));
    }
  }

  const tracks: TimelineTrack[] = [
    { id: asTrackId(id('track-video')), kind: 'video', muted: false, clips: videoClips },
  ];
  if (audioClips.length > 0) {
    tracks.push({
      id: asTrackId(id('track-audio')),
      kind: 'audio',
      muted: false,
      clips: audioClips,
    });
  }
  const durationUs = Math.max(0, ...segments.map((s) => s.startUs + s.durationUs));
  return { assets, tracks, durationUs };
}

function clipFor(asset: MediaAsset, segment: HostSegment, clipId: string): Clip {
  return {
    id: asClipId(clipId),
    assetId: asset.id,
    sourceRange: { startUs: asTimestampUs(0), durationUs: asset.durationUs },
    timelineStartUs: asTimestampUs(segment.startUs),
    effects: [],
  };
}
