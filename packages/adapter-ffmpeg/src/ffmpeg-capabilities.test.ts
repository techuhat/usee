import { describe, expect, it } from 'vitest';

import { asCorrelationId } from '@usee/contracts';

import {
  parseFfmpegEncoderListing,
  probeFfmpegCapabilities,
  type FfmpegCommandResult,
} from './ffmpeg-capabilities';
import type { VerifiedFfmpegRuntime } from './ffmpeg-runtime';

const correlationId = asCorrelationId('ffmpeg-capabilities-test');
const runtime: VerifiedFfmpegRuntime = {
  executablePath: 'C:/app/resources/ffmpeg/ffmpeg.exe',
  manifest: {
    manifestVersion: 1,
    version: '7.1.1',
    binaryName: 'ffmpeg.exe',
    sha256: 'a'.repeat(64),
    source: {
      url: 'https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz',
      revision: 'b'.repeat(40),
    },
    license: {
      spdx: 'LGPL-2.1-or-later',
      reviewReference: 'LEGAL-123',
      reviewedAt: '2026-01-01T00:00:00.000Z',
    },
    builtAt: '2026-01-01T00:00:00.000Z',
    configureFlags: ['--disable-everything'],
    enabledEncoders: ['aac', 'h264_mf', 'libx264'],
  },
};

/** FFmpeg's listings for a runtime with everything export needs, as `-encoders` and the rest print them. */
const COMPLETE_LISTINGS: Readonly<Record<string, string>> = {
  '-encoders': [
    'Encoders:',
    ' V..... = Video',
    ' ------',
    ' V....D h264_mf Media Foundation H.264 encoder',
    ' V..... libx264 libx264 H.264 encoder',
    ' V..... wrapped_avframe AVFrame to AVPacket passthrough',
    ' A....D aac AAC encoder',
    ' A..... libfdk_aac unapproved AAC encoder',
    ' A....D pcm_s16le PCM signed 16-bit little-endian',
    ' S..... srt Subtitle encoder',
  ].join('\n'),
  '-muxers': [
    'File formats:',
    ' D.. = Demuxing supported',
    ' .E. = Muxing supported',
    ' ---',
    '  E  mov             QuickTime / MOV',
    '  E  mp4             MP4 (MPEG-4 Part 14)',
    '  E  null            raw null video',
  ].join('\n'),
  '-demuxers': [
    'File formats:',
    ' D.. = Demuxing supported',
    ' .E. = Muxing supported',
    ' ---',
    ' D   mov,mp4,m4a,3gp,3g2,mj2 QuickTime / MOV',
    ' D   rawvideo        raw video',
  ].join('\n'),
  '-decoders': [
    'Decoders:',
    ' VFS..D h264                 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10',
    ' V....D rawvideo             raw video',
    ' A....D aac                  AAC (Advanced Audio Coding)',
  ].join('\n'),
};

/** A runner that answers each fixed probe with a listing, `overrides` replacing some. */
function listings(overrides: Readonly<Record<string, string>> = {}) {
  const calls: (readonly string[])[] = [];
  const run = (executablePath: string, args: readonly string[]) => {
    expect(executablePath).toBe(runtime.executablePath);
    calls.push(args);
    const output: FfmpegCommandResult = {
      outcome: 'complete',
      exitCode: 0,
      stdout: { ...COMPLETE_LISTINGS, ...overrides }[args[1] ?? ''] ?? '',
      stderr: '',
    };
    return Promise.resolve(output);
  };
  return { run, calls };
}

describe('FFmpeg capability probe', () => {
  it('returns only manifest-approved audio and video encoders', async () => {
    const { run, calls } = listings();

    const result = await probeFfmpegCapabilities(runtime, correlationId, run);

    // Only fixed listings ever run: never arguments built from input.
    expect(calls).toEqual([
      ['-hide_banner', '-encoders'],
      ['-hide_banner', '-muxers'],
      ['-hide_banner', '-demuxers'],
      ['-hide_banner', '-decoders'],
    ]);
    expect(result).toEqual({
      ok: true,
      value: {
        runtimeVersion: '7.1.1',
        videoEncoders: ['h264_mf', 'libx264'],
        audioEncoders: ['aac'],
      },
    });
  });

  it('fails closed when the runtime cannot read frames, write the MP4 or validate it', async () => {
    // The first FFmpeg 9.0.2 candidate had no mp4 muxer and no null-sink encoders.
    for (const overrides of [
      { '-muxers': '  E  mov             QuickTime / MOV\n  E  null            raw null video' },
      { '-demuxers': ' D   mov,mp4,m4a,3gp,3g2,mj2 QuickTime / MOV' },
      { '-encoders': ' V....D h264_mf H.264\n A....D aac AAC\n A....D pcm_s16le PCM' },
      { '-decoders': ' VFS..D h264 H.264\n A....D aac AAC' },
    ]) {
      const result = await probeFfmpegCapabilities(runtime, correlationId, listings(overrides).run);
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'export.ffmpeg-runtime-incomplete', retryable: false, correlationId },
      });
    }
  });

  it('ignores subtitle encoders and duplicate entries', () => {
    expect(
      parseFfmpegEncoderListing(
        [' V..... libx264 H.264', ' V..... libx264 H.264 again', ' S..... srt Subtitle'].join('\n'),
        ['libx264', 'srt'],
      ),
    ).toEqual({ videoEncoders: ['libx264'], audioEncoders: [] });
  });

  it('maps a timed-out probe to a retryable export error', async () => {
    const result = await probeFfmpegCapabilities(runtime, correlationId, () =>
      Promise.resolve({
        outcome: 'timeout',
        exitCode: null,
        stdout: '',
        stderr: '',
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'export.ffmpeg-probe-timeout',
        retryable: true,
        correlationId,
      },
    });
  });

  it('maps launch failures and nonzero exits without leaking process output', async () => {
    for (const run of [
      () =>
        Promise.resolve({
          outcome: 'spawn-failed' as const,
          exitCode: null,
          stdout: '',
          stderr: 'private path',
        }),
      () =>
        Promise.resolve({
          outcome: 'complete' as const,
          exitCode: 1,
          stdout: '',
          stderr: 'private path',
        }),
    ]) {
      const result = await probeFfmpegCapabilities(runtime, correlationId, run);
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'export.ffmpeg-probe-failed' },
      });
      expect(JSON.stringify(result)).not.toContain('private path');
    }
  });
});
