import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  asAssetId,
  asClipId,
  asCorrelationId,
  asDurationUs,
  asJobId,
  asProjectId,
  asTimestampUs,
  asTrackId,
} from '@usee/contracts';
import {
  DEFAULT_AUTO_ZOOM_SETTINGS,
  DEFAULT_CANVAS_STYLE,
  DEFAULT_CURSOR_SETTINGS,
  EXPORT_PRESETS,
} from '@usee/domain';

import { createExportJobStore } from './export-job-store';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'export-job-store-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function store() {
  return createExportJobStore({
    filePath: path.join(root, 'exports', 'queue.json'),
    createCorrelationId: () => asCorrelationId('export-store-test'),
  });
}

function entry() {
  const jobId = asJobId('export-1');
  const projectId = asProjectId('project-1');
  const preset = EXPORT_PRESETS['mp4-h264-1080p30'];
  const assetId = asAssetId('asset-1');
  return {
    prepared: {
      job: {
        id: jobId,
        projectId,
        state: 'queued' as const,
        preset,
        destinationPath: 'C:/exports/export-1.mp4',
        createdAtUs: asTimestampUs(10),
      },
      plan: {
        planVersion: 1 as const,
        projectId,
        projectUpdatedAtUs: asTimestampUs(5),
        durationUs: asDurationUs(1_000_000),
        frameRate: preset.frameRate,
        preset,
        assets: [
          {
            id: assetId,
            kind: 'video' as const,
            durationUs: asDurationUs(1_000_000),
            dimensions: { width: 1920, height: 1080 },
            frameRate: preset.frameRate,
            hasAudio: false,
          },
        ],
        tracks: [
          {
            id: asTrackId('track-1'),
            kind: 'video' as const,
            muted: false,
            clips: [
              {
                id: asClipId('clip-1'),
                assetId,
                sourceStartUs: 0,
                sourceDurationUs: 1_000_000,
                timelineStartUs: 0,
                timelineDurationUs: 1_000_000,
                speed: 1,
                effects: [],
                pointer: null,
              },
            ],
          },
        ],
        analysisRuns: [],
        canvas: DEFAULT_CANVAS_STYLE,
        cursor: DEFAULT_CURSOR_SETTINGS,
        autoZoom: DEFAULT_AUTO_ZOOM_SETTINGS,
      },
      planHash: 'a'.repeat(64),
    },
    update: {
      job: {
        id: asJobId('render-1'),
        exportJobId: jobId,
        state: 'queued' as const,
        progress: 0,
        createdAtUs: asTimestampUs(10),
      },
      error: null,
    },
  };
}

describe('export job store', () => {
  it('writes and reads a validated queue snapshot atomically', async () => {
    const repository = store();
    const saved = await repository.save([entry()]);
    expect(saved, JSON.stringify(saved)).toMatchObject({ ok: true });
    const loaded = await repository.load();

    expect(loaded).toMatchObject({ ok: true, value: [{ update: { job: { state: 'queued' } } }] });
    const contents = await readFile(path.join(root, 'exports', 'queue.json'), 'utf8');
    expect(contents).toContain('"formatVersion":1');
    expect(contents).not.toContain('relativePath');
  });

  it('starts empty when there is no queue file', async () => {
    await expect(store().load()).resolves.toEqual({ ok: true, value: [] });
  });

  it('rejects malformed persisted snapshots without returning partial records', async () => {
    const filePath = path.join(root, 'exports', 'queue.json');
    await mkdir(path.dirname(filePath));
    await writeFile(filePath, '{"formatVersion":1,"entries":[{"untrusted":true}]}');

    await expect(store().load()).resolves.toMatchObject({
      ok: false,
      error: { code: 'storage.export-queue-invalid' },
    });
  });
});
