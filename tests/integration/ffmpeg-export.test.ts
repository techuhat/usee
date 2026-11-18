import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createFfmpegExportWorker,
  probeFfmpegCapabilities,
  type VerifiedFfmpegRuntime,
} from '@usee/adapter-ffmpeg';
import type { ValidatedExportArtifact } from '@usee/application';
import {
  asAssetId,
  asClipId,
  asCorrelationId,
  asDurationUs,
  asJobId,
  asProjectId,
  asTimestampUs,
  asTrackId,
  ok,
} from '@usee/contracts';
import {
  DEFAULT_AUTO_ZOOM_SETTINGS,
  DEFAULT_CANVAS_STYLE,
  DEFAULT_CURSOR_SETTINGS,
  EXPORT_PRESETS,
  type ExportJob,
  type RenderPlan,
} from '@usee/domain';

// Runs only against a real FFmpeg build (none is checked in): the one
// USEE_FFMPEG_EXE names, or the repository's `npm run build:ffmpeg` output. It
// checks that the exact commands the export worker sends work with that
// build, which the unit tests' fake runner cannot.
const developmentBuild = path.resolve('build/ffmpeg/resources/ffmpeg/ffmpeg.exe');
const ffmpegPath =
  process.env['USEE_FFMPEG_EXE'] ?? (existsSync(developmentBuild) ? developmentBuild : undefined);
const correlationId = asCorrelationId('ffmpeg-export-integration');
const preset = EXPORT_PRESETS['mp4-h264-1080p30'];

/** A frame as the renderer sends one: raw RGBA, here a dark field with a box moving across it. */
function frame(width: number, height: number, index: number, count: number): Uint8Array {
  const box = { w: Math.round(width / 6), h: Math.round(height / 4) };
  const left = Math.round(((width - box.w) * index) / Math.max(1, count - 1));
  const top = Math.round((height - box.h) / 2);
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inBox = y >= top && y < top + box.h && x >= left && x < left + box.w;
      pixels.set(inBox ? [242, 190, 50, 255] : [20, 26, 64, 255], (y * width + x) * 4);
    }
  }
  return pixels;
}

function runtimeAt(executablePath: string): VerifiedFfmpegRuntime {
  return {
    executablePath,
    manifest: {
      manifestVersion: 1,
      version: '9.0.2',
      binaryName: 'ffmpeg.exe',
      sha256: 'a'.repeat(64),
      source: { url: 'https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz', revision: 'b'.repeat(40) },
      license: {
        spdx: 'LGPL-2.1-or-later',
        reviewReference: 'integration-test',
        reviewedAt: '2026-11-07T00:00:00.000Z',
      },
      builtAt: '2026-11-07T00:00:00.000Z',
      configureFlags: ['--disable-everything'],
      enabledEncoders: ['aac', 'h264_mf'],
    },
  };
}

/** A one-second, video-only plan at the 1080p30 preset. */
function plan(): RenderPlan {
  const videoAssetId = asAssetId('video-1');
  return {
    planVersion: 1,
    projectId: asProjectId('project-1'),
    projectUpdatedAtUs: asTimestampUs(1),
    durationUs: asDurationUs(1_000_000),
    frameRate: preset.frameRate,
    preset,
    assets: [
      {
        id: videoAssetId,
        kind: 'video',
        durationUs: asDurationUs(1_000_000),
        dimensions: { width: 1920, height: 1080 },
        frameRate: preset.frameRate,
        hasAudio: false,
      },
    ],
    tracks: [
      {
        id: asTrackId('video-track'),
        kind: 'video',
        muted: false,
        clips: [
          {
            id: asClipId('video-clip'),
            assetId: videoAssetId,
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
  };
}

const cancellation = {
  get isCancellationRequested() {
    return false;
  },
  throwIfCancellationRequested() {},
};

describe.skipIf(ffmpegPath === undefined || !existsSync(ffmpegPath))(
  'the export worker against a real FFmpeg build',
  () => {
    const executablePath = ffmpegPath ?? '';
    let root = '';

    beforeEach(async () => {
      root = await mkdtemp(path.join(tmpdir(), 'usee-ffmpeg-export-'));
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('finds every component the export commands use in the build', async () => {
      const probed = await probeFfmpegCapabilities(runtimeAt(executablePath), correlationId);
      // A build without the mp4 muxer, the null sink's encoders or the decoders is refused here.
      expect(probed).toEqual(
        ok({ runtimeVersion: '9.0.2', videoEncoders: ['h264_mf'], audioEncoders: ['aac'] }),
      );
    });

    it('exports raw frames to an MP4 that decodes cleanly, and publishes its hash', async () => {
      const runtime = runtimeAt(executablePath);
      const probed = await probeFfmpegCapabilities(runtime, correlationId);
      if (!probed.ok) {
        throw new Error(`The build is incomplete: ${probed.error.code}`);
      }
      const exportPlan = plan();
      const job: ExportJob = {
        id: asJobId('export-1'),
        projectId: exportPlan.projectId,
        state: 'queued',
        preset,
        destinationPath: path.join(root, 'export.mp4'),
        createdAtUs: asTimestampUs(1),
      };
      const published: { artifact: ValidatedExportArtifact; bytes: Buffer }[] = [];
      const worker = createFfmpegExportWorker({
        runtime,
        capabilities: probed.value,
        frameSource: {
          async stream(_job, _plan, _cancellation, writeFrame) {
            const count = 30;
            for (let index = 0; index < count; index += 1) {
              await writeFrame(frame(1920, 1080, index, count), (index + 1) / count);
            }
            return ok(undefined);
          },
        },
        mediaPaths: { resolve: () => Promise.resolve(ok({})) },
        publisher: {
          async publish(artifact) {
            const bytes = await readFile(path.join(root, 'work', job.id, 'output.partial.mp4'));
            published.push({ artifact, bytes });
            return ok(undefined);
          },
        },
        workRoot: path.join(root, 'work'),
        createCorrelationId: () => correlationId,
      });

      const result = await worker.run(job, exportPlan, 'a'.repeat(64), cancellation, () => {});

      expect(result).toEqual(ok(undefined));
      const [output] = published;
      expect(output).toBeDefined();
      if (output === undefined) return;
      expect(output.artifact.sizeBytes).toBe(output.bytes.length);
      expect(output.artifact.sha256).toBe(createHash('sha256').update(output.bytes).digest('hex'));
      // An MP4, not QuickTime: the brand FFmpeg's mp4 muxer writes.
      expect(output.bytes.subarray(4, 12).toString('latin1')).toBe('ftypisom');
    }, 120_000);

    it('fails validation on a damaged MP4 instead of printing errors and passing', async () => {
      const runtime = runtimeAt(executablePath);
      const probed = await probeFfmpegCapabilities(runtime, correlationId);
      if (!probed.ok) {
        throw new Error(`The build is incomplete: ${probed.error.code}`);
      }
      // A short, valid MP4 from the worker, then its first 40 KB alone.
      const exportPlan = plan();
      let bytes = Buffer.alloc(0);
      const worker = createFfmpegExportWorker({
        runtime,
        capabilities: probed.value,
        frameSource: {
          async stream(_job, _plan, _cancellation, writeFrame) {
            for (let index = 0; index < 30; index += 1) {
              await writeFrame(frame(1920, 1080, index, 30), (index + 1) / 30);
            }
            return ok(undefined);
          },
        },
        mediaPaths: { resolve: () => Promise.resolve(ok({})) },
        publisher: {
          async publish() {
            bytes = await readFile(path.join(root, 'work', 'export-2', 'output.partial.mp4'));
            return ok(undefined);
          },
        },
        workRoot: path.join(root, 'work'),
        createCorrelationId: () => correlationId,
      });
      const job: ExportJob = {
        id: asJobId('export-2'),
        projectId: exportPlan.projectId,
        state: 'queued',
        preset,
        destinationPath: path.join(root, 'export.mp4'),
        createdAtUs: asTimestampUs(1),
      };
      expect((await worker.run(job, exportPlan, 'a'.repeat(64), cancellation, () => {})).ok).toBe(
        true,
      );
      const damaged = path.join(root, 'damaged.mp4');
      await writeFile(damaged, bytes.subarray(0, Math.min(40_000, bytes.length - 1)));
      // The worker's validation command, as it sends it.
      const validate = (file: string) =>
        spawnSync(
          executablePath,
          ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-i', file].concat([
            '-map',
            '0:v:0',
            '-map',
            '0:a?',
            '-f',
            'null',
            '-',
          ]),
          { encoding: 'utf8' },
        ).status;
      expect(validate(damaged)).not.toBe(0);
    }, 120_000);
  },
);
