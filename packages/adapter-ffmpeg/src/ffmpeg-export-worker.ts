import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, rmdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

import type {
  ExportArtifactPublisherPort,
  ExportFrameSourcePort,
  ExportMediaPathResolverPort,
  ExportWorkerPort,
} from '@usee/application';
import {
  createAppError,
  err,
  ok,
  type AssetId,
  type CancellationToken,
  type CorrelationId,
  type Result,
} from '@usee/contracts';
import { exportDimensions, type RenderPlan } from '@usee/domain';

import type { FfmpegCapabilities } from './ffmpeg-capabilities';
import type { VerifiedFfmpegRuntime } from './ffmpeg-runtime';

const MAX_RENDER_FRAMES = 1_000_000;
const MAX_AUDIO_CLIPS = 256;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_BYTES = 4 * 1024 * 1024;
const SAFE_ENVIRONMENT_VARIABLES = ['SystemRoot', 'SystemDrive', 'windir', 'TEMP', 'TMP'] as const;

/**
 * Where the H.264 encoder runs: the GPU's Media Foundation encoder, or
 * Windows' own software one when the GPU has none or it fails.
 */
type VideoEncoding = 'hardware' | 'software';

type ExportWorkerErrorCode =
  | 'export.encoder-unavailable'
  | 'export.plan-too-complex'
  | 'export.source-media-missing'
  | 'export.workspace-failed'
  | 'export.render-failed'
  | 'export.frame-invalid'
  | 'export.ffmpeg-process-failed'
  | 'export.validation-failed'
  | 'export.artifact-invalid'
  | 'export.canceled';

export interface FfmpegExportWorkerOptions {
  readonly runtime: VerifiedFfmpegRuntime;
  readonly capabilities: FfmpegCapabilities;
  readonly frameSource: ExportFrameSourcePort;
  readonly mediaPaths: ExportMediaPathResolverPort;
  readonly publisher: ExportArtifactPublisherPort;
  /** Private app-data directory; each job uses its exact ID as a child name. */
  readonly workRoot: string;
  readonly createCorrelationId: () => CorrelationId;
  readonly runProcess?: FfmpegProcessRunner;
}

export interface FfmpegProcessRequest {
  readonly executablePath: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly cancellation: CancellationToken;
  readonly correlationId: CorrelationId;
  /** Called after spawn; the callback applies stream backpressure. */
  readonly streamInput?: (write: (bytes: Uint8Array) => Promise<void>) => Promise<Result<void>>;
}

export type FfmpegProcessRunner = (request: FfmpegProcessRequest) => Promise<Result<void>>;

function makeError(code: ExportWorkerErrorCode, correlationId: CorrelationId) {
  return createAppError({
    category: 'export',
    code,
    retryable: code === 'export.ffmpeg-process-failed' || code === 'export.workspace-failed',
    userMessageKey: `errors.${code}`,
    correlationId,
  });
}

function failure(code: ExportWorkerErrorCode, correlationId: CorrelationId): Result<never> {
  return err(makeError(code, correlationId));
}

function seconds(microseconds: number): string {
  return (microseconds / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function audioTempoFilters(speed: number): string[] {
  const filters: string[] = [];
  let remaining = speed;
  while (remaining < 0.5) {
    filters.push('atempo=0.5');
    remaining /= 0.5;
  }
  while (remaining > 2) {
    filters.push('atempo=2');
    remaining /= 2;
  }
  if (Math.abs(remaining - 1) > Number.EPSILON) {
    filters.push(`atempo=${seconds(remaining * 1_000_000)}`);
  }
  return filters;
}

interface AudioClipInput {
  readonly assetId: AssetId;
  readonly sourceStartUs: number;
  readonly sourceDurationUs: number;
  readonly timelineStartUs: number;
  readonly speed: number;
}

function audioInputs(plan: RenderPlan): AudioClipInput[] {
  const assets = new Map(plan.assets.map((asset) => [asset.id, asset]));
  const inputs: AudioClipInput[] = [];
  for (const track of plan.tracks) {
    if (track.muted || track.kind === 'effects') {
      continue;
    }
    for (const clip of track.clips) {
      const asset = assets.get(clip.assetId);
      if (asset?.kind === 'audio' || (asset?.kind === 'video' && asset.hasAudio)) {
        inputs.push({
          assetId: clip.assetId,
          sourceStartUs: clip.sourceStartUs,
          sourceDurationUs: clip.sourceDurationUs,
          timelineStartUs: clip.timelineStartUs,
          speed: clip.speed,
        });
      }
    }
  }
  return inputs;
}

function audioFilterGraph(inputs: readonly AudioClipInput[], durationUs: number): string {
  const chains = inputs.map((clip, index) => {
    const filters = [
      `atrim=start=${seconds(clip.sourceStartUs)}:duration=${seconds(clip.sourceDurationUs)}`,
      'asetpts=PTS-STARTPTS',
      ...audioTempoFilters(clip.speed),
      'aresample=48000',
      `adelay=${Math.round(clip.timelineStartUs / 1000)}:all=1`,
      'apad',
      `atrim=duration=${seconds(durationUs)}`,
    ];
    return `[${index + 1}:a:0]${filters.join(',')}[a${index}]`;
  });
  const labels = inputs.map((_clip, index) => `[a${index}]`).join('');
  chains.push(
    `${labels}amix=inputs=${inputs.length}:duration=longest:normalize=0,atrim=duration=${seconds(durationUs)}[aout]`,
  );
  return chains.join(';');
}

function encoderArguments(
  plan: RenderPlan,
  dimensions: Readonly<{ width: number; height: number }>,
  audio: readonly AudioClipInput[],
  assetPaths: Readonly<Record<string, string>>,
  outputPath: string,
  frameCount: number,
  encoding: VideoEncoding,
): string[] {
  const { preset } = plan;
  // Raw RGBA frames, exactly the composed canvas's pixels: no image to encode
  // in the renderer or decode here.
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-video_size',
    `${dimensions.width}x${dimensions.height}`,
    '-framerate',
    `${preset.frameRate.numerator}/${preset.frameRate.denominator}`,
    '-i',
    'pipe:0',
  ];
  for (const clip of audio) {
    const assetPath = assetPaths[clip.assetId];
    if (assetPath === undefined) {
      throw new Error('The audio asset path was not resolved.');
    }
    args.push('-i', assetPath);
  }
  if (audio.length > 0) {
    args.push('-filter_complex', audioFilterGraph(audio, plan.durationUs));
  }
  args.push(
    '-map',
    '0:v:0',
    ...(audio.length === 0
      ? ['-an']
      : [
          '-map',
          '[aout]',
          '-c:a',
          preset.audioCodec,
          '-b:a',
          `${preset.audioBitrateKbps}k`,
          '-ar',
          String(preset.audioSampleRateHz),
        ]),
    '-frames:v',
    String(frameCount),
    '-c:v',
    'h264_mf',
    '-hw_encoding',
    encoding === 'hardware' ? '1' : '0',
    // The preset's bitrate is the target: Media Foundation's default rate
    // control may ignore it (a GPU encoder gave 16-24 Mb/s for 8 Mb/s).
    '-rate_control',
    'cbr',
    '-b:v',
    `${preset.videoBitrateKbps}k`,
    // High profile, by FFmpeg's number for it: h264_mf takes no profile names.
    '-profile:v',
    '100',
    // The picture as players show it: converted from RGB with BT.709, the HD
    // matrix players assume and Chromium shows the recording with, and tagged
    // so. FFmpeg's default, BT.601, shifted saturated colours (a yellow of
    // 242,191,51 played back as 247,187,44).
    '-vf',
    'scale=out_color_matrix=bt709:out_range=tv,format=nv12',
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-color_range',
    'tv',
    // GPU encoders take NV12 and refuse planar YUV; the software one takes both.
    '-pix_fmt',
    'nv12',
    '-movflags',
    '+faststart',
    '-n',
    '-f',
    'mp4',
    outputPath,
  );
  return args;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

export function runFfmpegProcess(request: FfmpegProcessRequest): Promise<Result<void>> {
  return new Promise((resolve) => {
    if (request.cancellation.isCancellationRequested) {
      resolve(failure('export.canceled', request.correlationId));
      return;
    }
    const environment: NodeJS.ProcessEnv = {};
    for (const name of SAFE_ENVIRONMENT_VARIABLES) {
      const value = process.env[name];
      if (value !== undefined) {
        environment[name] = value;
      }
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(request.executablePath, [...request.arguments], {
        cwd: request.workingDirectory,
        env: environment,
        shell: false,
        windowsHide: true,
        stdio: [request.streamInput === undefined ? 'ignore' : 'pipe', 'ignore', 'pipe'],
      });
    } catch {
      resolve(failure('export.ffmpeg-process-failed', request.correlationId));
      return;
    }
    if (child.stderr === null || (request.streamInput !== undefined && child.stdin === null)) {
      child.kill();
      resolve(failure('export.ffmpeg-process-failed', request.correlationId));
      return;
    }

    // FFmpeg can leave before it has read every frame: when it cannot open the GPU's
    // encoder (the software one is tried next), or a job is cancelled. The write in
    // progress then fails and reports it, and the stream emits the same failure as an
    // event, which, unheard, would end the whole process as an uncaught exception.
    let inputBroken = false;
    child.stdin?.on('error', () => {
      inputBroken = true;
    });
    let stderrBytes = 0;
    let outputExceeded = false;
    let settled = false;
    let childError = false;
    const exited = new Promise<number | null>((done) => {
      child.once('error', () => {
        childError = true;
        done(null);
      });
      child.once('close', (code) => done(code));
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderrBytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk);
      if (stderrBytes > MAX_STDERR_BYTES && !outputExceeded) {
        outputExceeded = true;
        child.kill();
      }
    });

    const write = (bytes: Uint8Array) =>
      new Promise<void>((done, reject) => {
        const stdin = child.stdin;
        if (stdin === null || stdin.destroyed || inputBroken) {
          reject(new Error('FFmpeg input closed.'));
          return;
        }
        stdin.write(bytes, (cause) =>
          cause === null
            ? done()
            : reject(cause instanceof Error ? cause : new Error(String(cause))),
        );
      });

    const stop = () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    };
    const cancellationMonitor = setInterval(() => {
      if (request.cancellation.isCancellationRequested) {
        stop();
      }
    }, 100);

    const execute = async () => {
      let streamed: Result<void> = ok(undefined);
      try {
        if (request.streamInput !== undefined) {
          streamed = await request.streamInput(write);
        }
      } catch {
        streamed = failure('export.render-failed', request.correlationId);
      }
      if (!streamed.ok) {
        child.stdin?.destroy();
        stop();
      } else {
        child.stdin?.end();
      }
      const code = await exited;
      clearInterval(cancellationMonitor);
      if (settled) {
        return;
      }
      settled = true;
      if (request.cancellation.isCancellationRequested) {
        resolve(failure('export.canceled', request.correlationId));
      } else if (!streamed.ok) {
        resolve(streamed);
      } else if (outputExceeded || childError || code !== 0) {
        resolve(failure('export.ffmpeg-process-failed', request.correlationId));
      } else {
        resolve(ok(undefined));
      }
    };
    void execute();
  });
}

function frameCountFor(plan: RenderPlan): number | undefined {
  const { numerator, denominator } = plan.preset.frameRate;
  const count = Math.ceil((plan.durationUs * numerator) / (1_000_000 * denominator));
  return Number.isSafeInteger(count) && count > 0 && count <= MAX_RENDER_FRAMES ? count : undefined;
}

function sourceAspectFor(plan: RenderPlan): number | undefined {
  const assets = new Map(plan.assets.map((asset) => [asset.id, asset]));
  for (const track of plan.tracks) {
    if (track.kind !== 'video' || track.muted) {
      continue;
    }
    for (const clip of track.clips) {
      const asset = assets.get(clip.assetId);
      if (asset?.kind === 'video') {
        return asset.dimensions.width / asset.dimensions.height;
      }
    }
  }
  return undefined;
}

/** A raw RGBA frame of the output's size: four bytes a pixel, nothing more or less. */
function isFrameOfSize(
  bytes: Uint8Array,
  expected: Readonly<{ width: number; height: number }>,
): boolean {
  return bytes.byteLength === expected.width * expected.height * 4;
}

/** Serial worker: renderer-composed frames enter FFmpeg, audio is muxed, then output is checked and published. */
export function createFfmpegExportWorker(options: FfmpegExportWorkerOptions): ExportWorkerPort {
  const runProcess = options.runProcess ?? runFfmpegProcess;

  return {
    async run(job, plan, _planHash, cancellation, update) {
      const correlationId = options.createCorrelationId();
      const fail = (code: ExportWorkerErrorCode) => failure(code, correlationId);
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(job.id)) {
        return fail('export.workspace-failed');
      }
      if (!options.capabilities.videoEncoders.includes('h264_mf')) {
        return fail('export.encoder-unavailable');
      }
      const audios = audioInputs(plan);
      if (audios.length > MAX_AUDIO_CLIPS) {
        return fail('export.plan-too-complex');
      }
      if (audios.length > 0 && !options.capabilities.audioEncoders.includes('aac')) {
        return fail('export.encoder-unavailable');
      }
      const frameCount = frameCountFor(plan);
      const sourceAspect = sourceAspectFor(plan);
      if (frameCount === undefined || sourceAspect === undefined) {
        return fail('export.plan-too-complex');
      }
      const dimensions = exportDimensions(plan.preset, plan.canvas, sourceAspect);

      const projectId = plan.projectId;
      const mediaIds = [...new Set(audios.map((clip) => clip.assetId))];
      const resolved = await options.mediaPaths.resolve(projectId, mediaIds);
      if (!resolved.ok) {
        return err(resolved.error);
      }
      if (mediaIds.some((id) => !path.isAbsolute(resolved.value[id] ?? ''))) {
        return fail('export.source-media-missing');
      }

      let jobDirectory: string | undefined;
      const outputPath = path.join(options.workRoot, job.id, 'output.partial.mp4');
      try {
        await mkdir(options.workRoot, { recursive: true });
        await mkdir(path.join(options.workRoot, job.id));
        jobDirectory = path.join(options.workRoot, job.id);
      } catch {
        return fail('export.workspace-failed');
      }

      try {
        if (cancellation.isCancellationRequested) {
          return fail('export.canceled');
        }
        update('rendering', 0);
        let framesWritten = 0;
        let invalidFrame = false;
        // A retry starts the frames over, but what is reported never goes back.
        let reported = 0;
        const encodeWith = async (encoding: VideoEncoding) => {
          framesWritten = 0;
          let lastProgress = 0;
          let inputClosed = false;
          const result = await runProcess({
            executablePath: options.runtime.executablePath,
            arguments: encoderArguments(
              plan,
              dimensions,
              audios,
              resolved.value,
              outputPath,
              frameCount,
              encoding,
            ),
            workingDirectory: jobDirectory,
            cancellation,
            correlationId,
            streamInput: (write) =>
              options.frameSource.stream(job, plan, cancellation, async (frame, progress) => {
                if (cancellation.isCancellationRequested) {
                  throw new Error('Export canceled.');
                }
                if (
                  !Number.isFinite(progress) ||
                  progress < lastProgress ||
                  progress < 0 ||
                  progress > 1 ||
                  frame.byteLength > MAX_FRAME_BYTES ||
                  !isFrameOfSize(frame, dimensions) ||
                  framesWritten >= frameCount
                ) {
                  invalidFrame = true;
                  throw new Error('Invalid export frame stream.');
                }
                try {
                  await write(frame);
                } catch (cause) {
                  // FFmpeg stopped reading: its encoder failed.
                  inputClosed = true;
                  throw cause;
                }
                framesWritten += 1;
                lastProgress = progress;
                reported = Math.max(reported, Math.min(0.8, 0.05 + progress * 0.75));
                update('rendering', reported);
              }),
          });
          const encoderFailed =
            !result.ok && (inputClosed || result.error.code === 'export.ffmpeg-process-failed');
          return { result, encoderFailed };
        };
        // The GPU's encoder first; if it fails, the software one, from the first frame.
        let encode = await encodeWith('hardware');
        if (encode.encoderFailed && !invalidFrame && !cancellation.isCancellationRequested) {
          // FFmpeg refuses (`-n`) to overwrite what the failed run left.
          await unlink(outputPath).catch(() => undefined);
          encode = await encodeWith('software');
        }
        if (invalidFrame) {
          return fail('export.frame-invalid');
        }
        if (!encode.result.ok) {
          return encode.result;
        }
        if (framesWritten !== frameCount) {
          return fail('export.frame-invalid');
        }

        update('validating', 0.85);
        const validation = await runProcess({
          executablePath: options.runtime.executablePath,
          arguments: [
            '-hide_banner',
            '-nostdin',
            '-v',
            'error',
            // Any decode error fails validation; without it FFmpeg only prints them.
            '-xerror',
            '-i',
            outputPath,
            '-map',
            '0:v:0',
            '-map',
            '0:a?',
            '-f',
            'null',
            '-',
          ],
          workingDirectory: jobDirectory,
          cancellation,
          correlationId,
        });
        if (!validation.ok) {
          return cancellation.isCancellationRequested
            ? fail('export.canceled')
            : fail('export.validation-failed');
        }
        const outputInfo = await stat(outputPath);
        if (
          !outputInfo.isFile() ||
          !Number.isSafeInteger(outputInfo.size) ||
          outputInfo.size <= 0
        ) {
          return fail('export.artifact-invalid');
        }
        const sha256 = await sha256File(outputPath);
        update('publishing', 0.95);
        // Awaited, so the cleanup in `finally` waits for the publisher to be done with the output.
        return await options.publisher.publish({
          jobId: job.id,
          destinationPath: job.destinationPath,
          sha256,
          sizeBytes: outputInfo.size,
        });
      } catch {
        return cancellation.isCancellationRequested
          ? fail('export.canceled')
          : fail('export.render-failed');
      } finally {
        await unlink(outputPath).catch(() => undefined);
        if (jobDirectory !== undefined) {
          await rmdir(jobDirectory).catch(() => undefined);
        }
      }
    },
  };
}
