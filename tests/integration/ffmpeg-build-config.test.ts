import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { REQUIRED_FFMPEG_COMPONENTS } from '@usee/adapter-ffmpeg';
import { ffmpegRuntimeManifestSchema } from '@usee/contracts';

import { resolveExportRuntimeSource } from '../../apps/desktop/src/main/export-runtime-source';
import {
  APPROVED_ENCODERS,
  CONFIGURE_FLAGS,
  DEVELOPMENT_MANIFEST_FILE,
  developmentManifest,
  HARDENING_FLAGS,
  RUNTIME_MANIFEST_FILE,
  runtimeManifest,
} from '../../scripts/ffmpeg-build-config.mjs';

/** The components one `--enable-<kind>=a,b` flag turns on. */
function enabled(kind: string): string[] {
  return CONFIGURE_FLAGS.filter((flag) => flag.startsWith(`--enable-${kind}=`)).flatMap((flag) =>
    flag.slice(`--enable-${kind}=`.length).split(','),
  );
}

describe('the pinned FFmpeg build', () => {
  it('turns on every component the export commands use, and the approved encoders', () => {
    expect(enabled('muxer')).toEqual(
      expect.arrayContaining([...REQUIRED_FFMPEG_COMPONENTS.muxers]),
    );
    expect(enabled('demuxer')).toEqual(
      expect.arrayContaining([...REQUIRED_FFMPEG_COMPONENTS.demuxers]),
    );
    expect(enabled('encoder')).toEqual(
      expect.arrayContaining([...REQUIRED_FFMPEG_COMPONENTS.encoders, ...APPROVED_ENCODERS]),
    );
    expect(enabled('decoder')).toEqual(
      expect.arrayContaining([...REQUIRED_FFMPEG_COMPONENTS.decoders]),
    );
    // Hardware decoding needs the hwaccels, not only the D3D11 API.
    expect(enabled('hwaccel')).toEqual(['h264_d3d11va', 'h264_d3d11va2']);
    // LGPL only: nothing GPL, nonfree or networked.
    expect(CONFIGURE_FLAGS).not.toContain('--enable-gpl');
    expect(CONFIGURE_FLAGS).not.toContain('--enable-nonfree');
    expect(CONFIGURE_FLAGS).toContain('--disable-network');
    expect(HARDENING_FLAGS).toEqual(['--extra-cflags=-guard:cf', '--extra-ldflags=-guard:cf']);
  });

  it('is the configure command ADR-008 records, flag for flag', async () => {
    const adr = await readFile(path.resolve('docs/decisions/ADR-008-ffmpeg-licensing.md'), 'utf8');
    const block = /```text\n([\s\S]*?)```/.exec(adr)?.[1] ?? '';
    expect(block.trim().split(/\s+/)).toEqual([...CONFIGURE_FLAGS, ...HARDENING_FLAGS]);
  });

  it('writes where each kind of build reads: a release its manifest, an unpackaged build its own', () => {
    const where = (isPackaged: boolean) =>
      resolveExportRuntimeSource({
        isPackaged,
        appPath: 'apps/desktop',
        resourcesPath: 'resources',
      }).manifestFileName;
    expect(where(true)).toBe(RUNTIME_MANIFEST_FILE);
    expect(where(false)).toBe(DEVELOPMENT_MANIFEST_FILE);
    // The development manifest passes the schema but says plainly that no review accepted it.
    const development = ffmpegRuntimeManifestSchema.parse(
      developmentManifest({ sha256: 'd'.repeat(64), builtAt: '2026-11-07T00:00:00.000Z' }),
    );
    expect(development.license.reviewReference).toMatch(/^UNREVIEWED/);
  });

  it('writes a runtime manifest the app accepts, naming the legal review', () => {
    const manifest = runtimeManifest({
      sha256: 'c'.repeat(64),
      builtAt: '2026-11-07T00:00:00.000Z',
      review: { reference: 'LEGAL-1', reviewedAt: '2026-11-07T00:00:00.000Z' },
    });

    expect(ffmpegRuntimeManifestSchema.parse(manifest)).toMatchObject({
      version: '9.0.2',
      binaryName: 'ffmpeg.exe',
      license: { spdx: 'LGPL-2.1-or-later', reviewReference: 'LEGAL-1' },
      enabledEncoders: ['aac', 'h264_mf'],
    });
  });
});
