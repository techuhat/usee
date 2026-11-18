import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  asCorrelationId,
  asProjectId,
  type HostMergedRecording,
  type HostSegment,
  type HostSessionSummary,
} from '@usee/contracts';
import { decodeManifest } from '@usee/project-format';

import { createRecordingStore } from './recording-store';

let root = '';
let stagingRoot = '';
let projectsRoot = '';
const warnings: string[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'recording-store-'));
  stagingRoot = path.join(root, 'staging');
  projectsRoot = path.join(root, 'projects');
  await mkdir(stagingRoot);
  warnings.length = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function store(now = new Date(2026, 9, 17, 10, 30, 0)) {
  return createRecordingStore({
    stagingRoot,
    projectsRoot,
    now: () => now,
    createProjectId: () => asProjectId('project-1'),
    createCorrelationId: () => asCorrelationId('corr'),
    onWarning: (event) => warnings.push(event),
  });
}

/** Stages a session the way the host does: segment files plus a journal. */
async function stageSession(
  sessionId: string,
  contents: readonly string[] = ['v0', 'v1', 'a0'],
  source: Readonly<Record<string, unknown>> = { displayId: 'display-0a1b2c3d' },
) {
  const directory = path.join(stagingRoot, sessionId);
  await mkdir(directory);
  const segments: HostSegment[] = contents.map((content, position) => {
    const stream = content.startsWith('v') ? 'video' : 'audio';
    const index = Number(content.slice(1));
    return {
      stream,
      index,
      fileName: `${stream}-${String(index).padStart(5, '0')}.${stream === 'video' ? 'mp4' : 'm4a'}`,
      startUs: index * 10_000_000,
      durationUs: 10_000_000,
      bytes: Buffer.byteLength(`media:${content}`),
      sha256: createHash('sha256').update(`media:${content}`).digest('hex'),
      frames: stream === 'video' ? 600 : 480_000 + position,
    };
  });
  for (const [position, segment] of segments.entries()) {
    await writeFile(path.join(directory, segment.fileName), `media:${contents[position]}`);
  }
  const lines = [
    {
      record: 'session-started',
      sessionId,
      ...source,
      protocolMajor: 1,
      segmentDurationMs: 10_000,
      video: {
        width: 1920,
        height: 1080,
        frameRateNumerator: 60,
        frameRateDenominator: 1,
        encoderName: 'GPU H.264',
        hardwareEncoder: true,
      },
      audio: { sampleRateHz: 48_000, channels: 2 },
    },
    ...segments.map((segment) => ({ record: 'segment-closed', ...segment })),
  ];
  await writeFile(
    path.join(directory, 'journal.ndjson'),
    lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
  );
  const summary: HostSessionSummary = {
    sessionId,
    durationUs: 20_000_000,
    framesCaptured: 1200,
    framesEncoded: 1200,
    framesDropped: 0,
    audioDiscontinuities: 0,
    audioFailed: false,
    segments,
    failure: null,
  };
  return { directory, segments, summary };
}

describe('recording store', () => {
  it('imports a finished session into a complete bundle and clears staging', async () => {
    const { summary } = await stageSession('session-1');
    const result = await store().importSession('session-1', summary);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const bundle = result.value.projectPath;
    expect(path.basename(bundle)).toBe('Recording 2026-10-17 10-30-00.screenproj');
    expect(result.value.durationUs).toBe(20_000_000);

    const manifest = decodeManifest(await readFile(path.join(bundle, 'manifest.json'), 'utf8'));
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    for (const relativePath of Object.values(manifest.value.managedAssetPaths)) {
      await expect(
        readFile(path.join(bundle, ...relativePath.split('/')), 'utf8'),
      ).resolves.toMatch(/^media:/);
    }
    await expect(
      readFile(path.join(bundle, 'metadata', 'sessions', 'session-1.journal.ndjson'), 'utf8'),
    ).resolves.toContain('session-started');
    await expect(readdir(stagingRoot)).resolves.toEqual([]);
  });

  it('imports a merged recording and its waveform, then clears every staged file', async () => {
    const { directory } = await stageSession('session-1');
    await writeFile(path.join(directory, 'recording.mp4'), 'merged:media');
    await writeFile(path.join(directory, 'waveform.json'), '{"peaks":""}');
    await writeFile(path.join(directory, 'recording.partial.mp4'), 'left by a crash');
    await writeFile(path.join(directory, 'pointer.ndjson'), '{"format":"usee.pointer"}\n');
    const merged: HostMergedRecording = {
      sessionId: 'session-1',
      fileName: 'recording.mp4',
      durationUs: 20_000_000,
      bytes: Buffer.byteLength('merged:media'),
      sha256: 'c'.repeat(64),
      videoFrames: 1_200,
      hasAudio: true,
      segmentsMerged: 3,
      segmentsSkipped: 0,
      waveform: { fileName: 'waveform.json', peaksPerSecond: 100, peakCount: 2_000 },
    };

    const result = await store().importMergedSession('session-1', merged);
    expect(result).toMatchObject({ ok: true, value: { durationUs: 20_000_000 } });
    if (!result.ok) return;
    const bundle = result.value.projectPath;
    const manifest = decodeManifest(await readFile(path.join(bundle, 'manifest.json'), 'utf8'));
    expect(manifest.ok && manifest.value.managedAssetPaths).toEqual({
      'session-1-recording': 'media/originals/session-1/recording.mp4',
      'session-1-pointer': 'metadata/interactions/session-1.pointer.ndjson',
    });
    await expect(
      readFile(path.join(bundle, 'media', 'originals', 'session-1', 'recording.mp4'), 'utf8'),
    ).resolves.toBe('merged:media');
    await expect(
      readFile(path.join(bundle, 'derived', 'waveforms', 'session-1-recording.json'), 'utf8'),
    ).resolves.toBe('{"peaks":""}');
    await expect(
      readFile(path.join(bundle, 'metadata', 'interactions', 'session-1.pointer.ndjson'), 'utf8'),
    ).resolves.toContain('usee.pointer');
    expect(manifest.ok && manifest.value.project.recordingSessions[0]?.interactionAssetId).toBe(
      'session-1-pointer',
    );
    await expect(readdir(stagingRoot)).resolves.toEqual([]);

    const again = await stageSession('session-2');
    await expect(
      store().importMergedSession('session-2', { ...merged, sessionId: 'session-2' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'storage.recording-missing' } });
    await expect(readdir(again.directory)).resolves.toContain('journal.ndjson');
  });

  it('refuses a finished import whose segment does not match the summary', async () => {
    const { directory, summary } = await stageSession('session-1');
    await writeFile(path.join(directory, 'video-00001.mp4'), 'truncated');
    const result = await store().importSession('session-1', summary);
    expect(result).toMatchObject({ ok: false, error: { code: 'storage.segment-corrupt' } });
    await expect(readdir(directory)).resolves.toContain('journal.ndjson');
  });

  it('keeps how much older than its timestamp each picture is, as the host measured it', async () => {
    const { directory, summary } = await stageSession('session-1', ['v0', 'a0']);
    const finalized = {
      record: 'session-finalized',
      durationUs: 10_000_000,
      framesEncoded: 600,
      framesDropped: 0,
      segments: 2,
      captureLatencyUs: 31_500,
    };
    await appendFile(path.join(directory, 'journal.ndjson'), `${JSON.stringify(finalized)}\n`);

    const result = await store().importSession('session-1', summary);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const manifest = decodeManifest(
      await readFile(path.join(result.value.projectPath, 'manifest.json'), 'utf8'),
    );
    if (!manifest.ok) throw new Error('The manifest did not decode.');
    const video = manifest.value.project.assets.filter((asset) => asset.kind === 'video');
    expect(video.map((asset) => asset.captureLatencyUs)).toEqual([31_500]);
    // Audio has no picture to wait for.
    expect(
      manifest.value.project.assets.find((asset) => asset.kind === 'audio'),
    ).not.toHaveProperty('captureLatencyUs');
  });

  it('names a recorded window by its ID in the project', async () => {
    const { summary } = await stageSession('session-1', ['v0'], {
      sourceKind: 'window',
      windowId: 'window-00000000000a0b0c',
    });
    const result = await store().importSession('session-1', summary);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const manifest = decodeManifest(
      await readFile(path.join(result.value.projectPath, 'manifest.json'), 'utf8'),
    );
    expect(manifest.ok && manifest.value.project.recordingSessions[0]?.sources).toEqual([
      { kind: 'window', windowId: 'window-00000000000a0b0c', coordinateSpace: 'capture' },
    ]);
  });

  it('keeps a recorded region in the project', async () => {
    const { summary } = await stageSession('session-1', ['v0'], {
      sourceKind: 'region',
      displayId: 'display-0a1b2c3d',
      region: { x: 100, y: 50, width: 640, height: 360 },
    });

    const result = await store().importSession('session-1', summary);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const manifest = decodeManifest(
      await readFile(path.join(result.value.projectPath, 'manifest.json'), 'utf8'),
    );
    expect(manifest.ok && manifest.value.project.recordingSessions[0]?.sources).toEqual([
      {
        kind: 'region',
        coordinateSpace: 'capture',
        region: { x: 100, y: 50, width: 640, height: 360 },
      },
    ]);
  });

  it('refuses a journal that does not name what it recorded', async () => {
    for (const source of [
      { sourceKind: 'window' },
      { sourceKind: 'region', displayId: 'display-0a1b2c3d' },
    ]) {
      const { directory, summary } = await stageSession('session-1', ['v0'], source);
      const result = await store().importSession('session-1', summary);
      expect(result).toMatchObject({ ok: false, error: { code: 'storage.journal-invalid' } });
      await rm(directory, { recursive: true });
    }
  });

  it('resumes an interrupted import into the same bundle', async () => {
    const { directory, summary } = await stageSession('session-1');
    const bundle = path.join(projectsRoot, 'Recording earlier.screenproj');
    const media = path.join(bundle, 'media', 'originals', 'session-1');
    await mkdir(media, { recursive: true });
    await writeFile(path.join(media, 'video-00000.mp4'), 'media:v0');
    await rm(path.join(directory, 'video-00000.mp4'));
    await writeFile(
      path.join(directory, 'import-target.json'),
      JSON.stringify({ projectDirectory: bundle }),
    );

    const result = await store().importSession('session-1', summary);
    expect(result).toMatchObject({ ok: true, value: { projectPath: bundle } });
    await expect(readFile(path.join(bundle, 'manifest.json'), 'utf8')).resolves.toContain(
      'video-00000.mp4',
    );
  });

  it('ignores an import marker that points outside the projects root', async () => {
    const { directory, summary } = await stageSession('session-1');
    const outside = path.join(root, 'elsewhere.screenproj');
    await writeFile(
      path.join(directory, 'import-target.json'),
      JSON.stringify({ projectDirectory: outside }),
    );

    const result = await store().importSession('session-1', summary);
    expect(result.ok && path.dirname(result.value.projectPath)).toBe(projectsRoot);
  });

  it('names a second bundle from the same second distinctly', async () => {
    const first = await stageSession('session-1');
    const second = await stageSession('session-2');
    const recording = store();
    const a = await recording.importSession('session-1', first.summary);
    const b = await recording.importSession('session-2', second.summary);
    expect(a.ok && path.basename(a.value.projectPath)).toBe(
      'Recording 2026-10-17 10-30-00.screenproj',
    );
    expect(b.ok && path.basename(b.value.projectPath)).toBe(
      'Recording 2026-10-17 10-30-00 (2).screenproj',
    );
  });

  it('lists interrupted sessions except the active one and non-session folders', async () => {
    await stageSession('session-1');
    await stageSession('session-2', ['v0']);
    await mkdir(path.join(stagingRoot, 'no-journal'));
    await mkdir(path.join(stagingRoot, 'bad name'));

    const listed = await store().listInterrupted('session-2');
    expect(listed).toMatchObject({
      ok: true,
      value: [
        { sessionId: 'session-1', segmentCount: 3, durationUs: 20_000_000, finalized: false },
      ],
    });
  });

  it('recovers intact segments and skips ones whose hash no longer matches', async () => {
    const { directory } = await stageSession('session-1');
    await writeFile(path.join(directory, 'video-00001.mp4'), 'media:XX'); // same size, other bytes

    const result = await store().recoverSession('session-1');
    expect(result).toMatchObject({
      ok: true,
      value: { sessionId: 'session-1', durationUs: 10_000_000 },
    });
    expect(warnings).toEqual(['recording.recovery.segment-skipped']);
  });

  it('discards only the files the host wrote', async () => {
    const { directory } = await stageSession('session-1');
    await writeFile(path.join(directory, 'notes.txt'), 'not ours');

    await expect(store().discardSession('session-1')).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(readdir(directory)).resolves.toEqual(['notes.txt']);
  });

  it('rejects session IDs that could name another directory', async () => {
    for (const sessionId of ['..', 'a/b', 'C:', '']) {
      await expect(store().discardSession(sessionId)).resolves.toMatchObject({
        ok: false,
        error: { code: 'storage.invalid-session' },
      });
    }
  });
});
