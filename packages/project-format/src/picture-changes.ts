import { z } from 'zod';

import { err, ok, pictureChangeSchema, type Result } from '@usee/contracts';

/**
 * `derived/picture-changes/<asset id>.json`: where a recording's picture
 * changed, as the editor found it from decoded frames (never keystrokes).
 * Like every derived artifact it records its producer and algorithm
 * (docs/project-format.md). A recording's media never changes, so its asset
 * ID names the input; a missing or invalid file only means focus analysis
 * runs without it, and the editor reads the picture again.
 */
export const pictureChangesFileSchema = z
  .object({
    format: z.literal('usee.picture-changes'),
    version: z.literal(1),
    producer: z.string().min(1).max(64),
    algorithm: z.literal('cell-luma-v1'),
    sampleIntervalUs: z.number().int().min(10_000).max(1_000_000),
    generatedAt: z.iso.datetime(),
    changes: z.array(pictureChangeSchema).max(100_000),
  })
  .strict();
export type PictureChangesFile = z.output<typeof pictureChangesFileSchema>;

/** Bundle-relative path of a recording's picture changes. */
export function pictureChangesPath(assetId: string): string {
  return `derived/picture-changes/${assetId}.json`;
}

export function decodePictureChanges(serialized: string): Result<PictureChangesFile, string> {
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch {
    return err('picture changes are not valid JSON');
  }
  const parsed = pictureChangesFileSchema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : err(parsed.error.issues[0]?.message ?? 'invalid');
}
