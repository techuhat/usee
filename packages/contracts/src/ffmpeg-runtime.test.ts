import { describe, expect, it } from 'vitest';

import { ffmpegRuntimeManifestSchema } from './ffmpeg-runtime';

const manifest = {
  manifestVersion: 1,
  version: '7.1.1',
  binaryName: 'ffmpeg.exe',
  sha256: 'a'.repeat(64),
  source: { url: 'https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz', revision: 'b'.repeat(40) },
  license: {
    spdx: 'LGPL-2.1-or-later',
    reviewReference: 'LEGAL-123',
    reviewedAt: '2026-10-20T00:00:00.000Z',
  },
  builtAt: '2026-10-21T00:00:00.000Z',
  configureFlags: ['--disable-everything', '--enable-encoder=h264_mf'],
  enabledEncoders: ['h264_mf', 'aac'],
};

describe('ffmpeg runtime manifest', () => {
  it('accepts a versioned manifest with source, checksum, codec and legal review metadata', () => {
    expect(ffmpegRuntimeManifestSchema.parse(manifest)).toMatchObject({
      version: '7.1.1',
      license: { spdx: 'LGPL-2.1-or-later', reviewReference: 'LEGAL-123' },
    });
  });

  it('rejects manifests without a trusted HTTPS source or recorded legal review', () => {
    expect(
      ffmpegRuntimeManifestSchema.safeParse({
        ...manifest,
        source: { ...manifest.source, url: 'http://example.test/ffmpeg.tar.xz' },
      }).success,
    ).toBe(false);
    expect(
      ffmpegRuntimeManifestSchema.safeParse({
        ...manifest,
        license: { ...manifest.license, reviewReference: '' },
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields and malformed binary checksums', () => {
    expect(ffmpegRuntimeManifestSchema.safeParse({ ...manifest, extra: true }).success).toBe(false);
    expect(
      ffmpegRuntimeManifestSchema.safeParse({ ...manifest, sha256: 'not-a-checksum' }).success,
    ).toBe(false);
  });
});
