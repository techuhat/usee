/**
 * A version 1 manifest as Phase 2 wrote it: one merged recording, one edited
 * clip, no cursor settings. Sanitized test data (docs/testing.md).
 */
export const MANIFEST_V1 = JSON.stringify({
  manifestVersion: 1,
  project: {
    id: 'project-fixture',
    schemaVersion: 1,
    title: 'Recording 2026-10-17 10-00-00',
    createdAtUs: 1_792_000_000_000_000,
    updatedAtUs: 1_792_000_100_000_000,
    assets: [
      {
        id: 'session-1-recording',
        kind: 'video',
        createdAtUs: 1_792_000_000_000_000,
        durationUs: 9_000_000,
        relativePath: 'media/originals/session-1/recording.mp4',
        dimensions: { width: 1920, height: 1080 },
        frameRate: { numerator: 60, denominator: 1 },
        hasAudio: true,
      },
    ],
    recordingSessions: [
      {
        id: 'session-1',
        startedAtUs: 0,
        endedAtUs: 9_000_000,
        sources: [
          {
            kind: 'display',
            displayId: 'display-0a1b2c3d',
            coordinateSpace: 'capture',
            bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          },
        ],
        videoAssetIds: ['session-1-recording'],
        audioAssetIds: [],
      },
    ],
    timeline: {
      id: 'session-1-timeline',
      frameRate: { numerator: 60, denominator: 1 },
      tracks: [
        {
          id: 'session-1-track-video',
          kind: 'video',
          muted: false,
          clips: [
            {
              id: 'session-1-clip-recording',
              assetId: 'session-1-recording',
              sourceRange: { startUs: 1_000_000, durationUs: 6_000_000 },
              timelineStartUs: 0,
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
    },
  },
  managedAssetPaths: { 'session-1-recording': 'media/originals/session-1/recording.mp4' },
  metadata: { encoderName: 'GPU H.264', hardwareEncoder: true },
});
