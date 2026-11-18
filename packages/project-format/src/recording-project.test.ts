import { describe, expect, it } from 'vitest';

import { asProjectId, asRecordingSessionId, type HostSegment } from '@usee/contracts';

import { decodeManifest, encodeManifest } from './manifest-schema';
import { createRecordingProject } from './recording-project';
import { isSafeRelativePath } from './relative-path';

const segment = (stream: 'video' | 'audio', index: number, startUs: number): HostSegment => ({
  stream,
  index,
  fileName: `${stream}-${String(index).padStart(5, '0')}.${stream === 'video' ? 'mp4' : 'm4a'}`,
  startUs,
  durationUs: 10_000_000,
  bytes: 1_000,
  sha256: 'a'.repeat(64),
  frames: stream === 'video' ? 600 : 480_000,
});

const input = {
  projectId: asProjectId('project-1'),
  title: 'Recording 2026-10-17 10-00-00',
  createdAtUs: 1_792_000_000_000_000,
  sessionId: asRecordingSessionId('session-1'),
  source: { kind: 'display', displayId: 'display-0a1b2c3d' },
  video: { width: 1920, height: 1080 },
  frameRate: { numerator: 60, denominator: 1 },
  audio: { sampleRateHz: 48_000, channels: 2 },
  media: {
    kind: 'segments',
    segments: [
      segment('video', 0, 0),
      segment('audio', 0, 0),
      segment('video', 1, 10_000_000),
      segment('audio', 1, 10_000_000),
    ],
  },
  hasPointer: false,
  metadata: { encoderName: 'GPU H.264', hardwareEncoder: true },
} as const;

describe('createRecordingProject', () => {
  it('keeps the measured capture latency on every video asset, never on audio', () => {
    const merged = createRecordingProject({
      ...input,
      captureLatencyUs: 31_500,
      media: { kind: 'merged', durationUs: 20_000_000, hasAudio: true },
    });
    expect(merged.project.assets[0]).toMatchObject({ kind: 'video', captureLatencyUs: 31_500 });
    expect(decodeManifest(JSON.stringify(merged)).ok).toBe(true);

    const segments = createRecordingProject({ ...input, captureLatencyUs: 31_500 });
    const latencies = segments.project.assets.map((asset) =>
      asset.kind === 'video' ? asset.captureLatencyUs : 'none',
    );
    expect(latencies).toEqual([31_500, 'none', 31_500, 'none']);
    // Pictures shown after their timestamps make it negative.
    const shownLater = createRecordingProject({
      ...input,
      captureLatencyUs: -11_500,
      media: { kind: 'merged', durationUs: 20_000_000, hasAudio: true },
    });
    expect(decodeManifest(JSON.stringify(shownLater)).ok).toBe(true);
    // Unmeasured (an interrupted session): absent, and the pointer is read as recorded.
    expect(createRecordingProject(input).project.assets[0]).not.toHaveProperty('captureLatencyUs');
  });

  it('makes a merged recording one asset and one clip spanning it', () => {
    const manifest = createRecordingProject({
      ...input,
      media: { kind: 'merged', durationUs: 20_000_000, hasAudio: true },
    });
    expect(manifest.project.assets).toEqual([
      expect.objectContaining({
        id: 'session-1-recording',
        kind: 'video',
        hasAudio: true,
        durationUs: 20_000_000,
        relativePath: 'media/originals/session-1/recording.mp4',
        sessionStartUs: 0,
      }),
    ]);
    expect(manifest.project.timeline.tracks).toEqual([
      expect.objectContaining({
        kind: 'video',
        clips: [
          expect.objectContaining({
            assetId: 'session-1-recording',
            sourceRange: { startUs: 0, durationUs: 20_000_000 },
            timelineStartUs: 0,
          }),
        ],
      }),
    ]);
    expect(manifest.project.recordingSessions[0]).toMatchObject({
      endedAtUs: 20_000_000,
      videoAssetIds: ['session-1-recording'],
      audioAssetIds: [],
    });
    expect(manifest.managedAssetPaths).toEqual({
      'session-1-recording': 'media/originals/session-1/recording.mp4',
    });
  });

  it('names the recorded display, a recorded window by its ID alone, or the region', () => {
    const display = createRecordingProject({ ...input });
    expect(display.project.recordingSessions[0]?.sources).toEqual([
      {
        kind: 'display',
        displayId: 'display-0a1b2c3d',
        coordinateSpace: 'capture',
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      },
    ]);

    const window = createRecordingProject({
      ...input,
      source: { kind: 'window', windowId: 'window-00000000000a0b0c' },
    });
    expect(window.project.recordingSessions[0]?.sources).toEqual([
      { kind: 'window', windowId: 'window-00000000000a0b0c', coordinateSpace: 'capture' },
    ]);
    expect(encodeManifest(window).ok).toBe(true);

    const region = createRecordingProject({
      ...input,
      source: { kind: 'region', region: { x: 100, y: 50, width: 640, height: 360 } },
    });
    expect(region.project.recordingSessions[0]?.sources).toEqual([
      {
        kind: 'region',
        coordinateSpace: 'capture',
        region: { x: 100, y: 50, width: 640, height: 360 },
      },
    ]);
    expect(encodeManifest(region).ok).toBe(true);
  });

  it('keeps a recorded pointer stream as an event asset of the session', () => {
    const manifest = createRecordingProject({
      ...input,
      media: { kind: 'merged', durationUs: 20_000_000, hasAudio: true },
      hasPointer: true,
    });
    expect(manifest.project.assets).toContainEqual(
      expect.objectContaining({
        id: 'session-1-pointer',
        kind: 'event',
        eventEncoding: 'jsonl',
        relativePath: 'metadata/interactions/session-1.pointer.ndjson',
        durationUs: 20_000_000,
      }),
    );
    expect(manifest.project.recordingSessions[0]?.interactionAssetId).toBe('session-1-pointer');
    // Interaction streams are data for effects, not clips.
    expect(manifest.project.timeline.tracks.flatMap((track) => track.clips)).toHaveLength(1);
  });

  it('puts each segment on the timeline at its session time', () => {
    const manifest = createRecordingProject(input);
    const [video, audio] = manifest.project.timeline.tracks;
    expect(video?.kind).toBe('video');
    expect(video?.clips.map((clip) => clip.timelineStartUs)).toEqual([0, 10_000_000]);
    // Each segment file starts at its own zero, at the segment's session time.
    expect(
      manifest.project.assets.map((asset) =>
        asset.kind === 'event' ? null : asset.sessionStartUs,
      ),
    ).toEqual([0, 0, 10_000_000, 10_000_000]);
    expect(audio?.kind).toBe('audio');
    expect(audio?.clips).toHaveLength(2);
    expect(manifest.project.recordingSessions[0]?.endedAtUs).toBe(20_000_000);
    expect(manifest.managedAssetPaths['session-1-video-00001']).toBe(
      'media/originals/session-1/video-00001.mp4',
    );
  });

  it('omits the audio track when the session had no microphone', () => {
    const manifest = createRecordingProject({
      ...input,
      audio: null,
      media: {
        kind: 'segments',
        segments: input.media.segments.filter((s) => s.stream === 'video'),
      },
    });
    expect(manifest.project.timeline.tracks.map((track) => track.kind)).toEqual(['video']);
  });

  it('starts with the looks it is given, and the built-in defaults without', () => {
    const looks = {
      autoZoom: { enabled: true, scale: 2.5, disabled: [], turn3d: 0.6 },
      canvas: {
        aspect: 'source',
        background: { kind: 'gradient', from: '#1b2550', to: '#6d3bd1', angle: 135 },
        padding: 0.08,
        cornerRadius: 0.03,
        shadow: { opacity: 0.45, blur: 0.04, offsetY: 0.01 },
      },
    } as const;
    const styled = createRecordingProject({ ...input, looks });
    expect(styled.project.settings.autoZoom).toEqual(looks.autoZoom);
    expect(styled.project.settings.canvas).toEqual(looks.canvas);
    const encoded = encodeManifest(styled);
    expect(encoded.ok).toBe(true);

    const plain = createRecordingProject(input).project.settings;
    expect(plain.autoZoom).toEqual({ enabled: true, scale: 2, disabled: [] });
    expect(plain.canvas.padding).toBe(0);
  });

  it('round-trips through the v1 codec', () => {
    const manifest = createRecordingProject(input);
    const encoded = encodeManifest(manifest);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(decodeManifest(encoded.value)).toEqual({ ok: true, value: manifest });
  });

  it('rejects manifests from unknown versions and with unsafe paths', () => {
    const manifest = createRecordingProject(input);
    expect(decodeManifest(JSON.stringify({ ...manifest, manifestVersion: 12 })).ok).toBe(false);
    expect(decodeManifest(JSON.stringify({ ...manifest, manifestVersion: 1 })).ok).toBe(false);
    expect(
      decodeManifest(JSON.stringify({ ...manifest, managedAssetPaths: { a: '../../secret.mp4' } }))
        .ok,
    ).toBe(false);
    expect(decodeManifest('{not json').ok).toBe(false);
  });
});

describe('isSafeRelativePath', () => {
  it.each(['manifest.json', 'media/originals/s-1/video-00000.mp4', 'derived/waveforms/a b.bin'])(
    'accepts %s',
    (path) => expect(isSafeRelativePath(path)).toBe(true),
  );

  it.each([
    '',
    '/abs/path',
    '../up',
    'media/../manifest.json',
    'media//x',
    'C:/Windows',
    'media\\x',
    'media/./x',
    'trailing.',
    'NUL',
    'media/con.txt',
  ])('rejects %j', (path) => expect(isSafeRelativePath(path)).toBe(false));
});
