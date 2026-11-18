import { spawn } from 'node:child_process';

import { createAppError, err, ok, type CorrelationId, type Result } from '@usee/contracts';

import type { VerifiedFfmpegRuntime } from './ffmpeg-runtime';

const PROBE_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const ENCODER_PROBE = ['-hide_banner', '-encoders'] as const;
const MUXER_PROBE = ['-hide_banner', '-muxers'] as const;
const DEMUXER_PROBE = ['-hide_banner', '-demuxers'] as const;
const DECODER_PROBE = ['-hide_banner', '-decoders'] as const;
type ProbeArguments =
  typeof ENCODER_PROBE | typeof MUXER_PROBE | typeof DEMUXER_PROBE | typeof DECODER_PROBE;

/**
 * What the export worker's commands need besides its approved encoders
 * (ffmpeg-export-worker.ts). A build without them starts, then fails every
 * export: the first FFmpeg 9.0.2 candidate had no mp4 muxer and no null-sink
 * encoders, so it is refused here, before any export.
 */
export const REQUIRED_FFMPEG_COMPONENTS = {
  /** The MP4 it writes, and the null sink validation decodes into. */
  muxers: ['mp4', 'null'],
  /** Raw frames from the renderer; the recordings' audio and the MP4 validation reads. */
  demuxers: ['rawvideo', 'mov'],
  /** The null sink's own video and audio codecs. */
  encoders: ['wrapped_avframe', 'pcm_s16le'],
  /** Raw frames in; validation decodes the H.264 and AAC written. */
  decoders: ['rawvideo', 'h264', 'aac'],
} as const;
const SAFE_ENVIRONMENT_VARIABLES = ['SystemRoot', 'SystemDrive', 'windir', 'TEMP', 'TMP'] as const;

export interface FfmpegCapabilities {
  readonly runtimeVersion: string;
  readonly videoEncoders: readonly string[];
  readonly audioEncoders: readonly string[];
}

export interface FfmpegCommandResult {
  readonly outcome: 'complete' | 'timeout' | 'output-too-large' | 'spawn-failed';
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Replaced by tests; production always receives one of the fixed probe argument lists. */
export type FfmpegCommandRunner = (
  executablePath: string,
  args: ProbeArguments,
) => Promise<FfmpegCommandResult>;

function runListing(executablePath: string, args: ProbeArguments): Promise<FfmpegCommandResult> {
  return new Promise((resolve) => {
    const environment: NodeJS.ProcessEnv = {};
    for (const name of SAFE_ENVIRONMENT_VARIABLES) {
      const value = process.env[name];
      if (value !== undefined) {
        environment[name] = value;
      }
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executablePath, args, {
        env: environment,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      resolve({ outcome: 'spawn-failed', exitCode: null, stdout: '', stderr: '' });
      return;
    }
    if (child.stdout === null || child.stderr === null) {
      child.kill();
      resolve({ outcome: 'spawn-failed', exitCode: null, stdout: '', stderr: '' });
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const timeout = { current: undefined as ReturnType<typeof setTimeout> | undefined };
    const finish = (result: FfmpegCommandResult) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout.current !== undefined) {
        clearTimeout(timeout.current);
      }
      resolve(result);
    };
    const collect = (target: Buffer[]) => (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill();
        finish({ outcome: 'output-too-large', exitCode: null, stdout: '', stderr: '' });
        return;
      }
      target.push(bytes);
    };

    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', () =>
      finish({ outcome: 'spawn-failed', exitCode: null, stdout: '', stderr: '' }),
    );
    child.once('close', (exitCode) =>
      finish({
        outcome: 'complete',
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );
    timeout.current = setTimeout(() => {
      child.kill();
      finish({ outcome: 'timeout', exitCode: null, stdout: '', stderr: '' });
    }, PROBE_TIMEOUT_MS);
  });
}

/**
 * Parses FFmpeg's `-encoders` listing and intersects it with the reviewed
 * runtime manifest, so unapproved encoders never become application choices.
 */
export function parseFfmpegEncoderListing(
  listing: string,
  approvedEncoders: readonly string[],
): Pick<FfmpegCapabilities, 'videoEncoders' | 'audioEncoders'> {
  const approved = new Set(approvedEncoders);
  const video = new Set<string>();
  const audio = new Set<string>();
  const encoderLine = /^\s*([VAS])([A-Z.]{5})\s+([a-zA-Z0-9_]+)(?:\s|$)/gm;

  for (const match of listing.matchAll(encoderLine)) {
    const mediaType = match[1];
    const name = match[3];
    if (name === undefined || !approved.has(name)) {
      continue;
    }
    if (mediaType === 'V') {
      video.add(name);
    } else if (mediaType === 'A') {
      audio.add(name);
    }
  }

  return {
    videoEncoders: [...video].sort(),
    audioEncoders: [...audio].sort(),
  };
}

/** The codec names an `-encoders` or `-decoders` listing shows, of any media type. */
function listedCodecs(listing: string): Set<string> {
  const line = /^\s*[VAS][A-Z.]{5}\s+([a-zA-Z0-9_]+)(?:\s|$)/gm;
  return new Set([...listing.matchAll(line)].flatMap((match) => match[1] ?? []));
}

/** The format names a `-muxers` or `-demuxers` listing shows; a row may name several, comma-separated. */
function listedFormats(listing: string): Set<string> {
  const line = /^ [D ][E ][d ] ([a-z0-9_,]+)(?:\s|$)/gm;
  return new Set([...listing.matchAll(line)].flatMap((match) => match[1]?.split(',') ?? []));
}

function probeFailure(
  code:
    | 'export.ffmpeg-probe-failed'
    | 'export.ffmpeg-probe-timeout'
    | 'export.ffmpeg-probe-output-too-large'
    | 'export.ffmpeg-runtime-incomplete',
  correlationId: CorrelationId,
): Result<never> {
  return err(
    createAppError({
      category: 'export',
      code,
      retryable: code === 'export.ffmpeg-probe-timeout',
      userMessageKey: `errors.${code}`,
      correlationId,
    }),
  );
}

/**
 * Probes only a runtime already returned by `verifyFfmpegRuntime`: its
 * encoders, muxers, demuxers and decoders, each a fixed listing. A runtime missing a
 * component the export commands need is refused, so export stays off rather
 * than failing every job.
 */
export async function probeFfmpegCapabilities(
  runtime: VerifiedFfmpegRuntime,
  correlationId: CorrelationId,
  run: FfmpegCommandRunner = runListing,
): Promise<Result<FfmpegCapabilities>> {
  const listing = async (args: ProbeArguments): Promise<Result<string>> => {
    let result: FfmpegCommandResult;
    try {
      result = await run(runtime.executablePath, args);
    } catch {
      return probeFailure('export.ffmpeg-probe-failed', correlationId);
    }
    if (result.outcome === 'timeout') {
      return probeFailure('export.ffmpeg-probe-timeout', correlationId);
    }
    if (result.outcome === 'output-too-large') {
      return probeFailure('export.ffmpeg-probe-output-too-large', correlationId);
    }
    if (result.outcome !== 'complete' || result.exitCode !== 0) {
      return probeFailure('export.ffmpeg-probe-failed', correlationId);
    }
    return ok(`${result.stdout}\n${result.stderr}`);
  };

  const encoders = await listing(ENCODER_PROBE);
  if (!encoders.ok) {
    return encoders;
  }
  const muxers = await listing(MUXER_PROBE);
  if (!muxers.ok) {
    return muxers;
  }
  const demuxers = await listing(DEMUXER_PROBE);
  if (!demuxers.ok) {
    return demuxers;
  }
  const decoders = await listing(DECODER_PROBE);
  if (!decoders.ok) {
    return decoders;
  }
  const [encoderNames, muxerNames, demuxerNames, decoderNames] = [
    listedCodecs(encoders.value),
    listedFormats(muxers.value),
    listedFormats(demuxers.value),
    listedCodecs(decoders.value),
  ];
  const complete =
    REQUIRED_FFMPEG_COMPONENTS.encoders.every((name) => encoderNames.has(name)) &&
    REQUIRED_FFMPEG_COMPONENTS.muxers.every((name) => muxerNames.has(name)) &&
    REQUIRED_FFMPEG_COMPONENTS.demuxers.every((name) => demuxerNames.has(name)) &&
    REQUIRED_FFMPEG_COMPONENTS.decoders.every((name) => decoderNames.has(name));
  if (!complete) {
    return probeFailure('export.ffmpeg-runtime-incomplete', correlationId);
  }

  return ok({
    runtimeVersion: runtime.manifest.version,
    ...parseFfmpegEncoderListing(encoders.value, runtime.manifest.enabledEncoders),
  });
}
