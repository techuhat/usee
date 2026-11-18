import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ExportFrameSourcePort,
  ExportMediaPathResolverPort,
  ValidatedExportArtifact,
} from '@usee/application';
import {
  asAssetId,
  asClipId,
  asCorrelationId,
  asDurationUs,
  asJobId,
  asProjectId,
  asTimestampUs,
  asTrackId,
  createAppError,
  err,
  ok,
  type Result,
} from '@usee/contracts';
import {
  DEFAULT_AUTO_ZOOM_SETTINGS,
  DEFAULT_CANVAS_STYLE,
  DEFAULT_CURSOR_SETTINGS,
  EXPORT_PRESETS,
  type ExportJob,
  type RenderPlan,
} from '@usee/domain';

import type { FfmpegCapabilities } from './ffmpeg-capabilities';
import {
  createFfmpegExportWorker,
  type FfmpegProcessRequest,
  type FfmpegProcessRunner,
} from './ffmpeg-export-worker';
import type { VerifiedFfmpegRuntime } from './ffmpeg-runtime';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ffmpeg-export-worker-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const projectId = asProjectId('project-1');
const videoAssetId = asAssetId('video-1');
const preset = EXPORT_PRESETS['mp4-h264-1080p30'];
/** One raw RGBA frame at the preset's size, as the renderer sends them. */
const frameBytes = new Uint8Array(1920 * 1080 * 4);

function planWithAudio(audioAssetId?: ReturnType<typeof asAssetId>): RenderPlan {
  return {
    planVersion: 1,
    projectId,
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
      ...(audioAssetId === undefined
        ? []
        : [
            {
              id: audioAssetId,
              kind: 'audio' as const,
              durationUs: asDurationUs(1_000_000),
              channels: 2,
              sampleRateHz: 48_000,
            },
          ]),
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
      ...(audioAssetId === undefined
        ? []
        : [
            {
              id: asTrackId('audio-track'),
              kind: 'audio' as const,
              muted: false,
              clips: [
                {
                  id: asClipId('audio-clip'),
                  assetId: audioAssetId,
                  sourceStartUs: 0,
                  sourceDurationUs: 1_000_000,
                  timelineStartUs: 0,
                  timelineDurationUs: 500_000,
                  speed: 2,
                  effects: [],
                  pointer: null,
                },
              ],
            },
          ]),
    ],
    analysisRuns: [],
    canvas: DEFAULT_CANVAS_STYLE,
    cursor: DEFAULT_CURSOR_SETTINGS,
    autoZoom: DEFAULT_AUTO_ZOOM_SETTINGS,
  };
}

function job(plan: RenderPlan): ExportJob {
  return {
    id: asJobId('export-1'),
    projectId: plan.projectId,
    state: 'queued',
    preset: plan.preset,
    destinationPath: path.join(root, 'export.mp4'),
    createdAtUs: asTimestampUs(1),
  };
}

const capabilities: FfmpegCapabilities = {
  runtimeVersion: '9.0.2',
  videoEncoders: ['h264_mf'],
  audioEncoders: ['aac'],
};

const runtime = {
  executablePath: 'C:/usee/resources/ffmpeg/ffmpeg.exe',
  manifest: {},
} as VerifiedFfmpegRuntime;

function cancellation() {
  return {
    get isCancellationRequested() {
      return false;
    },
    throwIfCancellationRequested() {},
  };
}

function frameSource(count = 30, frame = frameBytes): ExportFrameSourcePort {
  return {
    async stream(_job, _plan, _cancellation, writeFrame) {
      try {
        for (let index = 0; index < count; index += 1) {
          await writeFrame(frame, count <= 1 ? 1 : index / (count - 1));
        }
      } catch {
        return err(
          createAppError({
            category: 'export',
            code: 'export.render-failed',
            retryable: true,
            userMessageKey: 'errors.export.render-failed',
            correlationId: asCorrelationId('worker-test'),
          }),
        );
      }
      return ok(undefined);
    },
  };
}

function runner(options: {
  readonly frames: Uint8Array[];
  readonly requests: FfmpegProcessRequest[];
  readonly validation?: 'pass' | 'fail';
}): FfmpegProcessRunner {
  return async (request) => {
    options.requests.push(request);
    if (request.streamInput === undefined) {
      return options.validation === 'fail'
        ? err(
            createAppError({
              category: 'export',
              code: 'export.ffmpeg-process-failed',
              retryable: false,
              userMessageKey: 'errors.export.ffmpeg-process-failed',
              correlationId: asCorrelationId('worker-test'),
            }),
          )
        : ok(undefined);
    }
    const result = await request.streamInput((bytes) => {
      options.frames.push(bytes);
      return Promise.resolve();
    });
    if (!result.ok) {
      return result;
    }
    await writeFile(request.arguments.at(-1) ?? '', Buffer.from('encoded mp4'));
    return ok(undefined);
  };
}

function createWorker(options: {
  readonly plan: RenderPlan;
  readonly frameSource?: ExportFrameSourcePort;
  readonly paths?: ExportMediaPathResolverPort;
  readonly runProcess?: FfmpegProcessRunner;
  readonly publish?: (artifact: ValidatedExportArtifact) => Promise<Result<void>>;
  readonly caps?: FfmpegCapabilities;
}) {
  const plan = options.plan;
  const frames: Uint8Array[] = [];
  const requests: FfmpegProcessRequest[] = [];
  const published: ValidatedExportArtifact[] = [];
  const worker = createFfmpegExportWorker({
    runtime,
    capabilities: options.caps ?? capabilities,
    frameSource: options.frameSource ?? frameSource(),
    mediaPaths:
      options.paths ??
      ({
        resolve: () => Promise.resolve(ok({})),
      } satisfies ExportMediaPathResolverPort),
    publisher: {
      async publish(artifact) {
        published.push(artifact);
        return options.publish === undefined ? ok(undefined) : options.publish(artifact);
      },
    },
    workRoot: path.join(root, 'work'),
    createCorrelationId: () => asCorrelationId('worker-test'),
    runProcess: options.runProcess ?? runner({ frames, requests }),
  });
  return { worker, plan, job: job(plan), frames, requests, published };
}

describe('FFmpeg export worker', () => {
  it('streams a bounded frame sequence, validates the MP4, and publishes its hash', async () => {
    const context = createWorker({ plan: planWithAudio() });
    const states: string[] = [];

    const result = await context.worker.run(
      context.job,
      context.plan,
      'a'.repeat(64),
      cancellation(),
      (state) => states.push(state),
    );

    expect(result).toEqual(ok(undefined));
    expect(context.frames).toHaveLength(30);
    expect(states[0]).toBe('rendering');
    expect(states.at(-2)).toBe('validating');
    expect(states.at(-1)).toBe('publishing');
    expect(context.requests[0]?.arguments).toContain('rawvideo');
    expect(context.requests[0]?.arguments).toContain('h264_mf');
    expect(context.requests[1]?.arguments).toContain('0:a?');
    expect(context.published[0]).toMatchObject({
      jobId: context.job.id,
      destinationPath: context.job.destinationPath,
      sizeBytes: Buffer.byteLength('encoded mp4'),
      sha256: createHash('sha256').update('encoded mp4').digest('hex'),
    });
    await expect(
      readFile(path.join(root, 'work', context.job.id, 'output.partial.mp4')),
    ).rejects.toThrow();
  });

  it('mutes no audio implicitly and compiles retimed audio using separate input arguments', async () => {
    const audioAssetId = asAssetId('audio-1');
    const audioPath = path.join(root, 'music.wav');
    await writeFile(audioPath, 'synthetic audio input');
    const context = createWorker({
      plan: planWithAudio(audioAssetId),
      paths: {
        resolve: vi.fn(() => Promise.resolve(ok({ [audioAssetId]: audioPath }))),
      },
    });

    const result = await context.worker.run(
      context.job,
      context.plan,
      'a'.repeat(64),
      cancellation(),
      () => undefined,
    );

    expect(result.ok).toBe(true);
    const args = context.requests[0]?.arguments ?? [];
    expect(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2)).toEqual(['-i', 'pipe:0']);
    expect(args).toContain(audioPath);
    const graph = args[args.indexOf('-filter_complex') + 1] ?? '';
    expect(graph).toContain('atempo=2');
    expect(graph).toContain('adelay=0:all=1');
    expect(graph).toContain('amix=inputs=1');
  });

  it('fails closed when the verified runtime lacks the required encoder', async () => {
    const context = createWorker({
      plan: planWithAudio(),
      caps: { ...capabilities, videoEncoders: [] },
    });

    await expect(
      context.worker.run(
        context.job,
        context.plan,
        'a'.repeat(64),
        cancellation(),
        () => undefined,
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'export.encoder-unavailable' } });
    expect(context.requests).toHaveLength(0);
  });

  it('rejects a frame with the wrong pixel dimensions before publication', async () => {
    // A 1280 x 720 frame where a 1920 x 1080 one belongs.
    const wrongSize = new Uint8Array(1280 * 720 * 4);
    const context = createWorker({
      plan: planWithAudio(),
      frameSource: frameSource(30, wrongSize),
    });

    await expect(
      context.worker.run(
        context.job,
        context.plan,
        'a'.repeat(64),
        cancellation(),
        () => undefined,
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'export.frame-invalid' } });
    expect(context.published).toHaveLength(0);
  });

  it('encodes on the GPU first at the preset bitrate, High profile, and validates strictly', async () => {
    const context = createWorker({ plan: planWithAudio() });

    await context.worker.run(context.job, context.plan, 'a'.repeat(64), cancellation(), () => {});

    const encode = context.requests[0]?.arguments ?? [];
    const after = (flag: string) => encode[encode.indexOf(flag) + 1];
    const afterLast = (flag: string) => encode[encode.lastIndexOf(flag) + 1];
    expect(after('-hw_encoding')).toBe('1');
    expect(after('-rate_control')).toBe('cbr');
    expect(after('-b:v')).toBe(`${preset.videoBitrateKbps}k`);
    expect(after('-profile:v')).toBe('100');
    // Raw RGBA in, at the output's size; NV12 out to the encoder.
    expect(after('-f')).toBe('rawvideo');
    expect(after('-pix_fmt')).toBe('rgba');
    expect(after('-video_size')).toBe('1920x1080');
    expect(afterLast('-pix_fmt')).toBe('nv12');
    // RGB to YUV with the HD matrix players assume, and tagged so.
    expect(after('-vf')).toBe('scale=out_color_matrix=bt709:out_range=tv,format=nv12');
    expect([after('-colorspace'), after('-color_primaries'), after('-color_trc')]).toEqual([
      'bt709',
      'bt709',
      'bt709',
    ]);
    expect(after('-color_range')).toBe('tv');
    expect(encode.slice(-3)).toEqual(['-f', 'mp4', encode.at(-1)]);
    // A truncated or damaged MP4 must fail validation, not only print errors.
    expect(context.requests[1]?.arguments).toContain('-xerror');
  });

  it('encodes again in software, from the first frame, when the GPU encoder fails', async () => {
    const requests: FfmpegProcessRequest[] = [];
    const frames: Uint8Array[] = [];
    const software = runner({ frames, requests });
    const context = createWorker({
      plan: planWithAudio(),
      runProcess: async (request) => {
        const hardware = request.arguments.includes('-hw_encoding')
          ? request.arguments[request.arguments.indexOf('-hw_encoding') + 1] === '1'
          : false;
        if (request.streamInput !== undefined && hardware) {
          requests.push(request);
          // The GPU encoder takes two frames, then FFmpeg exits and its input closes.
          let accepted = 0;
          await request.streamInput(() => {
            accepted += 1;
            return accepted <= 2 ? Promise.resolve() : Promise.reject(new Error('EPIPE'));
          });
          await writeFile(request.arguments.at(-1) ?? '', Buffer.from('partial'));
          return err(
            createAppError({
              category: 'export',
              code: 'export.render-failed',
              retryable: true,
              userMessageKey: 'errors.export.render-failed',
              correlationId: asCorrelationId('worker-test'),
            }),
          );
        }
        return software(request);
      },
    });

    const progress: number[] = [];
    const result = await context.worker.run(
      context.job,
      context.plan,
      'a'.repeat(64),
      cancellation(),
      (_state, value) => progress.push(value),
    );

    expect(result).toEqual(ok(undefined));
    // The coordinator refuses progress that goes back, so the retry never reports less.
    expect(progress).toEqual([...progress].sort((first, second) => first - second));
    const encodes = requests.filter((request) => request.streamInput !== undefined);
    expect(
      encodes.map((request) => request.arguments[request.arguments.indexOf('-hw_encoding') + 1]),
    ).toEqual(['1', '0']);
    // Every frame went to the software encoder, after the partial output was removed.
    expect(frames).toHaveLength(30);
    expect(context.published[0]?.sizeBytes).toBe(Buffer.byteLength('encoded mp4'));
  });

  it('does not retry when the frames, not the encoder, failed', async () => {
    // A 1280 x 720 frame where a 1920 x 1080 one belongs.
    const wrongSize = new Uint8Array(1280 * 720 * 4);
    const requests: FfmpegProcessRequest[] = [];
    const context = createWorker({
      plan: planWithAudio(),
      frameSource: frameSource(30, wrongSize),
      runProcess: runner({ frames: [], requests }),
    });

    await expect(
      context.worker.run(context.job, context.plan, 'a'.repeat(64), cancellation(), () => {}),
    ).resolves.toMatchObject({ ok: false, error: { code: 'export.frame-invalid' } });
    expect(requests.filter((request) => request.streamInput !== undefined)).toHaveLength(1);
  });

  it('keeps the output until the publisher has finished with it', async () => {
    let seen = '';
    const context = createWorker({
      plan: planWithAudio(),
      // As the real publisher does: it awaits, then reads the job's output.
      publish: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        seen = await readFile(path.join(root, 'work', 'export-1', 'output.partial.mp4'), 'utf8');
        return ok(undefined);
      },
    });

    const result = await context.worker.run(
      context.job,
      context.plan,
      'a'.repeat(64),
      cancellation(),
      () => {},
    );

    expect(result).toEqual(ok(undefined));
    expect(seen).toBe('encoded mp4');
  });

  it('rejects a decoder validation failure and leaves the destination untouched', async () => {
    const requests: FfmpegProcessRequest[] = [];
    const context = createWorker({
      plan: planWithAudio(),
      runProcess: runner({ frames: [], requests, validation: 'fail' }),
    });

    await expect(
      context.worker.run(
        context.job,
        context.plan,
        'a'.repeat(64),
        cancellation(),
        () => undefined,
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'export.validation-failed' } });
    expect(context.published).toHaveLength(0);
  });
});
