import { describe, expect, it } from 'vitest';

import {
  asAssetId,
  asClipId,
  asDurationUs,
  asProjectId,
  asRecordingSessionId,
  asSchemaVersion,
  asTimelineId,
  asTimestampUs,
  asTrackId,
  projectSnapshotSchema,
} from '@usee/contracts';

import type { ProjectSessionState } from './project-session';
import { toProjectSnapshot } from './project-snapshot';

const state: ProjectSessionState = {
  projectPath: 'C:/Users/me/Videos/usee/Recording.screenproj',
  revision: 3,
  canUndo: true,
  canRedo: false,
  saveState: 'saved',
  saveError: null,
  project: {
    id: asProjectId('project-1'),
    schemaVersion: asSchemaVersion(1),
    title: 'Recording',
    createdAtUs: asTimestampUs(0),
    updatedAtUs: asTimestampUs(0),
    assets: [
      {
        id: asAssetId('recording'),
        kind: 'video',
        createdAtUs: asTimestampUs(0),
        durationUs: asDurationUs(9_000_000),
        relativePath: 'media/originals/s/recording.mp4',
        dimensions: { width: 1920, height: 1080 },
        frameRate: { numerator: 60, denominator: 1 },
        hasAudio: true,
      },
      {
        id: asAssetId('clicks'),
        kind: 'event',
        createdAtUs: asTimestampUs(0),
        durationUs: asDurationUs(9_000_000),
        relativePath: 'metadata/interactions/s.jsonl',
        eventEncoding: 'jsonl',
      },
    ],
    recordingSessions: [],
    analysisRuns: [],
    timeline: {
      id: asTimelineId('timeline'),
      frameRate: { numerator: 60, denominator: 1 },
      tracks: [
        {
          id: asTrackId('video'),
          kind: 'video',
          muted: false,
          clips: [
            {
              id: asClipId('clip-1'),
              assetId: asAssetId('recording'),
              sourceRange: { startUs: asTimestampUs(1_000_000), durationUs: asDurationUs(3e6) },
              timelineStartUs: asTimestampUs(0),
              effects: [],
            },
            {
              id: asClipId('clip-2'),
              assetId: asAssetId('recording'),
              sourceRange: { startUs: asTimestampUs(6_000_000), durationUs: asDurationUs(2e6) },
              timelineStartUs: asTimestampUs(3_000_000),
              effects: [],
            },
          ],
        },
      ],
    },
    settings: {
      defaultFrameRate: { numerator: 60, denominator: 1 },
      previewQuality: 'full',
      colorSpace: 'sdr',
      cursor: { visible: true, size: 1.5, smoothing: 0.5, clickEffect: 'ripple' },
      autoZoom: { enabled: true, scale: 2, disabled: [] },
      canvas: {
        aspect: 'source',
        background: { kind: 'solid', color: '#0b1020' },
        padding: 0,
        cornerRadius: 0,
        shadow: { opacity: 0, blur: 0.04, offsetY: 0.01 },
      },
    },
  },
};

const url = `app://media/${'a'.repeat(32)}/recording`;

describe('toProjectSnapshot', () => {
  it('describes the timeline and playable media without any path', () => {
    const snapshot = toProjectSnapshot(state, (id) => (id === 'recording' ? url : undefined));
    expect(projectSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot).toMatchObject({
      projectId: 'project-1',
      revision: 3,
      durationUs: 5_000_000,
      assets: [{ id: 'recording', kind: 'video', hasAudio: true, mediaUrl: url }],
    });
    expect(snapshot.tracks[0]?.clips[1]).toEqual({
      id: 'clip-2',
      assetId: 'recording',
      sourceStartUs: 6_000_000,
      durationUs: 2_000_000,
      timelineStartUs: 3_000_000,
      speed: 1,
      effects: [],
    });
    expect(snapshot).toMatchObject({
      cursor: { visible: true, size: 1.5, smoothing: 0.5, clickEffect: 'ripple' },
      hasPointer: false,
    });
    expect(JSON.stringify(snapshot)).not.toContain('Videos');
  });

  it('points recorded media at the pointer stream recorded with it', () => {
    const withPointer: ProjectSessionState = {
      ...state,
      project: {
        ...state.project,
        assets: [
          ...state.project.assets.map((asset) =>
            asset.kind === 'video'
              ? { ...asset, sessionStartUs: asTimestampUs(2_000_000), captureLatencyUs: 31_500 }
              : asset,
          ),
          {
            id: asAssetId('pointer'),
            kind: 'event',
            createdAtUs: asTimestampUs(0),
            durationUs: asDurationUs(9_000_000),
            relativePath: 'metadata/interactions/s.pointer.ndjson',
            eventEncoding: 'jsonl',
          },
        ],
        recordingSessions: [
          {
            id: asRecordingSessionId('s'),
            startedAtUs: asTimestampUs(0),
            sources: [],
            videoAssetIds: [asAssetId('recording')],
            audioAssetIds: [],
            interactionAssetId: asAssetId('pointer'),
          },
        ],
      },
    };
    const snapshot = toProjectSnapshot(withPointer, () => url);
    expect(snapshot.hasPointer).toBe(true);
    expect(snapshot.assets).toEqual([
      expect.objectContaining({
        id: 'recording',
        pointer: {
          streamId: 'pointer',
          sessionStartUs: 2_000_000,
          captureLatencyUs: 31_500,
          autoZooms: [],
        },
      }),
    ]);
    expect(toProjectSnapshot(state, () => url).assets[0]?.pointer).toBeNull();

    // The zooms generated from the session's pointer stream come with it.
    const zoom = {
      id: 's-auto-3000000',
      startUs: asTimestampUs(2_000_000),
      durationUs: asDurationUs(2_500_000),
      poses: [{ timestampUs: asTimestampUs(2_600_000), anchor: { x: 0.3, y: 0.4 } }],
      easeInUs: 700_000,
      easeOutUs: 700_000,
    };
    const analysed: ProjectSessionState = {
      ...withPointer,
      project: {
        ...withPointer.project,
        analysisRuns: [
          {
            kind: 'camera-track',
            id: 's-camera',
            sessionId: asRecordingSessionId('s'),
            provenance: {
              strategy: 'click-focus',
              strategyVersion: 1,
              producer: 'usee 0.1.0',
              inputSha256: '0'.repeat(64),
              generatedAt: '2026-10-19T00:00:00.000Z',
            },
            zooms: [zoom],
          },
        ],
      },
    };
    const withZooms = toProjectSnapshot(analysed, () => url);
    expect(withZooms.assets[0]?.pointer?.autoZooms).toEqual([zoom]);
    expect(withZooms.autoZoom).toEqual({ enabled: true, scale: 2, disabled: [] });
    expect(projectSnapshotSchema.safeParse(withZooms).success).toBe(true);

    // Media that does not know its place on the session clock gets no pointer.
    const unplaced: ProjectSessionState = {
      ...withPointer,
      project: {
        ...withPointer.project,
        assets: [...state.project.assets, ...withPointer.project.assets.slice(-1)],
      },
    };
    expect(toProjectSnapshot(unplaced, () => url).assets[0]?.pointer).toBeNull();
  });

  it('leaves out assets the media server does not serve', () => {
    expect(toProjectSnapshot(state, () => undefined).assets).toEqual([]);
  });
});
