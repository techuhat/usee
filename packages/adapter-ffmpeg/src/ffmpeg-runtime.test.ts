import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { asCorrelationId } from '@usee/contracts';

import { verifyFfmpegRuntime } from './ffmpeg-runtime';

const correlationId = asCorrelationId('ffmpeg-runtime-test');
const binary = Buffer.from('test executable bytes');
const manifest = {
  manifestVersion: 1,
  version: '7.1.1',
  binaryName: 'ffmpeg.exe',
  sha256: createHash('sha256').update(binary).digest('hex'),
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

async function withRuntimeFiles(
  executableBytes: Buffer,
  run: (resources: string, manifestBytes: Buffer, trustedHash: string) => Promise<void>,
) {
  // Canonical, as the runtime check resolves the executable: the temporary folder may be
  // named by an 8.3 short name, as on GitHub's Windows runner (C:\Users\RUNNER~1\...).
  const resources = await realpath(await mkdtemp(path.join(os.tmpdir(), 'usee-ffmpeg-test-')));
  const directory = path.join(resources, 'ffmpeg');
  await mkdir(directory);
  await writeFile(path.join(directory, 'ffmpeg.exe'), executableBytes);
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const trustedHash = createHash('sha256').update(manifestBytes).digest('hex');
  try {
    await run(resources, manifestBytes, trustedHash);
  } finally {
    await rm(resources, { recursive: true, force: true });
  }
}

describe('verifyFfmpegRuntime', () => {
  it('accepts the app-owned binary only when manifest and executable hashes match', async () => {
    await withRuntimeFiles(binary, async (resources, manifestBytes, trustedHash) => {
      const verified = await verifyFfmpegRuntime(
        resources,
        manifestBytes,
        trustedHash,
        correlationId,
      );
      expect(verified).toMatchObject({
        ok: true,
        value: {
          executablePath: path.join(resources, 'ffmpeg', 'ffmpeg.exe'),
          manifest: { version: '7.1.1', license: { reviewReference: 'LEGAL-123' } },
        },
      });
    });
  });

  it('rejects a manifest whose bytes do not match the build-time trust anchor', async () => {
    await withRuntimeFiles(binary, async (resources, manifestBytes) => {
      const verified = await verifyFfmpegRuntime(
        resources,
        manifestBytes,
        '0'.repeat(64),
        correlationId,
      );
      expect(verified).toMatchObject({
        ok: false,
        error: { code: 'export.ffmpeg-manifest-untrusted' },
      });
    });
  });

  it('rejects a binary that does not match its reviewed manifest checksum', async () => {
    await withRuntimeFiles(Buffer.from('tampered executable'), async (resources, bytes, hash) => {
      const verified = await verifyFfmpegRuntime(resources, bytes, hash, correlationId);
      expect(verified).toMatchObject({
        ok: false,
        error: { code: 'export.ffmpeg-checksum-mismatch' },
      });
    });
  });

  it('rejects a trusted manifest with an invalid schema', async () => {
    const resources = await mkdtemp(path.join(os.tmpdir(), 'usee-ffmpeg-test-'));
    const manifestBytes = Buffer.from('{"manifestVersion":1}');
    const trustedHash = createHash('sha256').update(manifestBytes).digest('hex');
    try {
      const verified = await verifyFfmpegRuntime(
        resources,
        manifestBytes,
        trustedHash,
        correlationId,
      );
      expect(verified).toMatchObject({
        ok: false,
        error: { code: 'export.ffmpeg-manifest-invalid' },
      });
    } finally {
      await rm(resources, { recursive: true, force: true });
    }
  });
});
