import { z } from 'zod';

import { assetIdSchema } from './ids';

const unit = z.number().min(0).max(1);

/**
 * A region of a recording's picture that changed from a moment before
 * (Phase 6, "smarter focus"): its time in the recording, and its centre and
 * size normalized to the frame. Found from decoded frames, never keystrokes.
 */
export const pictureChangeSchema = z
  .object({
    timeUs: z
      .number()
      .int()
      .min(0)
      .max(24 * 3_600_000_000),
    x: unit,
    y: unit,
    w: unit,
    h: unit,
  })
  .strict()
  .readonly();
export type PictureChangeDto = z.output<typeof pictureChangeSchema>;

/** How the editor read one recording's picture, and where it changed. */
export const pictureAnalysisSchema = z
  .object({
    /** Mean luma of a grid of cells, compared frame to frame (picture-change-analysis.ts). */
    algorithm: z.literal('cell-luma-v1'),
    /** How often it looked: a frame every this many microseconds. */
    sampleIntervalUs: z.number().int().min(10_000).max(1_000_000),
    changes: z.array(pictureChangeSchema).max(100_000).readonly(),
  })
  .strict()
  .readonly();
export type PictureAnalysisDto = z.output<typeof pictureAnalysisSchema>;

export const savePictureChangesRequestSchema = z
  .object({ assetId: assetIdSchema, analysis: pictureAnalysisSchema })
  .strict()
  .readonly();
export type SavePictureChangesRequest = z.output<typeof savePictureChangesRequestSchema>;
