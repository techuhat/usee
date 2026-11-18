import { describe, expect, it, vi } from 'vitest';

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
  ok,
} from '@usee/contracts';
import type { PointerStream, Project } from '@usee/domain';

import {
  pointerFocusStrategy,
  pointerPictureFocusStrategy,
  staleCameraRuns,
  type AnalysisInputPort,
  type CameraAnalysisOptions,
} from './camera-analysis';

const SECOND = 1_000_000;
const PROJECT_PATH = 'C:/Videos/usee/Recording.screenproj';

const stream: PointerStream = {
  coordinateSpace: 'capture',
  display: { width: 1920, height: 1080, dpiScale: 1 },
  events: [
    { type: 'down', timeUs: asTimestampUs(2 * SECOND), x: 0.2, y: 0.3, button: 'left' },
    { type: 'down', timeUs: asTimestampUs(3 * SECOND), x: 0.7, y: 0.4, button: 'left' },
  ],
};

const project: Project = {
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
      durationUs: asDurationUs(10 * SECOND),
      relativePath: 'media/originals/s/recording.mp4',
      dimensions: { width: 1920, height: 1080 },
      frameRate: { numerator: 60, denominator: 1 },
      hasAudio: false,
      sessionStartUs: asTimestampUs(0),
    },
    {
      id: asAssetId('pointer'),
      kind: 'event',
      createdAtUs: asTimestampUs(0),
      durationUs: asDurationUs(10 * SECOND),
      relativePath: 'metadata/interactions/s.pointer.ndjson',
      eventEncoding: 'jsonl',
    },
  ],
  recordingSessions: [
    {
      id: asRecordingSessionId('s'),
      startedAtUs: asTimestampUs(0),
      endedAtUs: asTimestampUs(10 * SECOND),
      sources: [],
      videoAssetIds: [asAssetId('recording')],
      audioAssetIds: [],
      interactionAssetId: asAssetId('pointer'),
    },
  ],
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
            id: asClipId('clip'),
            assetId: asAssetId('recording'),
            sourceRange: { startUs: asTimestampUs(0), durationUs: asDurationUs(10 * SECOND) },
            timelineStartUs: asTimestampUs(0),
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
};

const options: CameraAnalysisOptions = {
  producer: 'usee 0.1.0',
  now: () => new Date('2026-10-19T10:00:00.000Z'),
};

function inputOf(sha256: string | null) {
  return {
    readPointerStream: vi.fn<AnalysisInputPort['readPointerStream']>(() =>
      Promise.resolve(ok(sha256 === null ? null : { stream, sha256 })),
    ),
  } satisfies AnalysisInputPort;
}

describe('camera analysis', () => {
  it('generates a camera track for each session with a pointer stream, with its provenance', async () => {
    const input = inputOf('a'.repeat(64));
    const runs = await staleCameraRuns(project, PROJECT_PATH, input, options);
    expect(input.readPointerStream).toHaveBeenCalledWith(
      PROJECT_PATH,
      'metadata/interactions/s.pointer.ndjson',
    );
    expect(runs).toEqual([
      {
        kind: 'camera-track',
        id: 's-camera',
        sessionId: 's',
        provenance: {
          strategy: 'pointer-focus',
          strategyVersion: 1,
          producer: 'usee 0.1.0',
          inputSha256: 'a'.repeat(64),
          generatedAt: '2026-10-19T10:00:00.000Z',
        },
        zooms: [
          {
            id: 's-auto-2000000',
            startUs: 1_000_000,
            durationUs: 3_500_000,
            poses: [
              { timestampUs: 1_600_000, anchor: { x: 0.2, y: 0.3 } },
              { timestampUs: 2_000_000, anchor: { x: 0.2, y: 0.3 } },
              { timestampUs: 2_600_000, anchor: { x: 0.7, y: 0.4 } },
            ],
            easeInUs: 700_000,
            easeOutUs: 700_000,
          },
        ],
      },
    ]);
  });

  it('keeps a current run, and makes one again for a new input or a new strategy version', async () => {
    const runs = await staleCameraRuns(project, PROJECT_PATH, inputOf('a'.repeat(64)), options);
    const analysed = { ...project, analysisRuns: runs };
    expect(await staleCameraRuns(analysed, PROJECT_PATH, inputOf('a'.repeat(64)), options)).toEqual(
      [],
    );
    expect(
      await staleCameraRuns(analysed, PROJECT_PATH, inputOf('b'.repeat(64)), options),
    ).toHaveLength(1);
    expect(
      await staleCameraRuns(analysed, PROJECT_PATH, inputOf('a'.repeat(64)), {
        ...options,
        strategy: { ...pointerFocusStrategy, version: pointerFocusStrategy.version + 1 },
      }),
    ).toHaveLength(1);
  });

  it('looks where the picture changed too, once the editor has read it, naming it in the input', async () => {
    const pointerOnly = inputOf('a'.repeat(64));
    const hashInputs = (hashes: readonly string[]) => (hashes.length === 1 ? 'x' : 'c').repeat(64);
    const pictureOptions = { ...options, strategy: pointerPictureFocusStrategy, hashInputs };
    // Before the picture is read: the pointer's focus, under the picture strategy's name.
    const [before] = await staleCameraRuns(project, PROJECT_PATH, pointerOnly, pictureOptions);
    expect(before?.provenance).toMatchObject({
      strategy: 'pointer-picture-focus',
      inputSha256: 'a'.repeat(64),
    });

    // A dialog opens at the right, well after the clicks.
    const withPicture = {
      ...pointerOnly,
      readPictureChanges: vi.fn<NonNullable<AnalysisInputPort['readPictureChanges']>>(() =>
        Promise.resolve(
          ok({
            changes: [{ timeUs: 7 * SECOND, x: 0.8, y: 0.7, w: 0.2, h: 0.2 }],
            sha256: 'p'.repeat(64),
          }),
        ),
      ),
    } satisfies AnalysisInputPort;
    const analysed = { ...project, analysisRuns: before === undefined ? [] : [before] };
    const [after] = await staleCameraRuns(analysed, PROJECT_PATH, withPicture, pictureOptions);
    expect(withPicture.readPictureChanges).toHaveBeenCalledWith(PROJECT_PATH, 'recording');
    expect(after?.provenance.inputSha256).toBe('c'.repeat(64));
    const anchors = after?.zooms.flatMap((zoom) => zoom.poses.map((pose) => pose.anchor)) ?? [];
    expect(anchors).toContainEqual({ x: 0.8, y: 0.7 });
    const dialogPose = (runs: Awaited<ReturnType<typeof staleCameraRuns>>) =>
      runs[0]?.zooms
        .flatMap((zoom) => zoom.poses)
        .find((pose) => pose.anchor.x === 0.8 && pose.anchor.y === 0.7)?.timestampUs;
    expect(dialogPose(after === undefined ? [] : [after])).toBe(6.6 * SECOND);

    // A picture 100 ms older than its frame time shows the screen 100 ms earlier on the session clock.
    const late = {
      ...project,
      assets: project.assets.map((asset) =>
        asset.kind === 'video' ? { ...asset, captureLatencyUs: 100_000 } : asset,
      ),
    };
    const lateRuns = await staleCameraRuns(late, PROJECT_PATH, withPicture, pictureOptions);
    expect(dialogPose(lateRuns)).toBe(6.5 * SECOND);
  });

  it('skips a session whose stream cannot be read, and stops once aborted', async () => {
    expect(await staleCameraRuns(project, PROJECT_PATH, inputOf(null), options)).toEqual([]);
    const input = inputOf('a'.repeat(64));
    expect(
      await staleCameraRuns(project, PROJECT_PATH, input, {
        ...options,
        signal: { aborted: true },
      }),
    ).toEqual([]);
    expect(input.readPointerStream).not.toHaveBeenCalled();
  });
});
