import { z } from 'zod';

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const encoderName = z.string().regex(/^[a-z0-9_]{1,64}$/);

/** Release provenance for the application-owned Windows FFmpeg executable. */
export const ffmpegRuntimeManifestSchema = z
  .object({
    manifestVersion: z.literal(1),
    version: z.string().min(1).max(64),
    binaryName: z.literal('ffmpeg.exe'),
    sha256,
    source: z
      .object({
        url: z.url().refine((value) => value.startsWith('https://')),
        revision: z.string().regex(/^[0-9a-f]{40}$/),
      })
      .readonly(),
    license: z
      .object({
        spdx: z.enum(['LGPL-2.1-or-later', 'GPL-2.0-or-later']),
        reviewReference: z.string().min(1).max(128),
        reviewedAt: z.iso.datetime(),
      })
      .readonly(),
    builtAt: z.iso.datetime(),
    configureFlags: z.array(z.string().min(1).max(128)).max(128).readonly(),
    enabledEncoders: z.array(encoderName).max(64).readonly(),
  })
  .strict()
  .readonly();

export type FfmpegRuntimeManifest = z.output<typeof ffmpegRuntimeManifestSchema>;
