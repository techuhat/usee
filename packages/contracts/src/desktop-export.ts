import { z } from 'zod';

import { appErrorSchema } from './errors';
import { renderJobSchema, renderPlanSchema } from './export-queue';
import { assetIdSchema, jobIdSchema } from './ids';
import { MEDIA_URL_PATTERN } from './project';
import { pointerTrackSchema } from './pointer';

export const exportPresetIdSchema = z.enum([
  'mp4-h264-1080p30',
  'mp4-h264-1080p60',
  'mp4-h264-1440p30',
  'mp4-h264-4k30',
]);

export const exportRuntimeStatusSchema = z
  .object({
    available: z.boolean(),
    reason: z.string().max(64).nullable(),
    videoEncoders: z.array(z.string().max(64)).max(64).readonly(),
    audioEncoders: z.array(z.string().max(64)).max(64).readonly(),
  })
  .strict()
  .readonly();
export type ExportRuntimeStatusDto = z.output<typeof exportRuntimeStatusSchema>;

/** Safe queue projection; the destination path and prepared job stay in main. */
export const exportJobStatusSchema = z
  .object({ job: renderJobSchema, error: appErrorSchema.nullable() })
  .strict()
  .readonly();
export type ExportJobStatusDto = z.output<typeof exportJobStatusSchema>;

export const exportQueueViewSchema = z
  .object({
    runtime: exportRuntimeStatusSchema,
    jobs: z.array(exportJobStatusSchema).max(10_000).readonly(),
  })
  .strict()
  .readonly();
export type ExportQueueViewDto = z.output<typeof exportQueueViewSchema>;

export const queueExportRequestSchema = z
  .object({ presetId: exportPresetIdSchema })
  .strict()
  .readonly();
export type QueueExportRequestDto = z.output<typeof queueExportRequestSchema>;

export const exportJobReferenceSchema = z.object({ exportJobId: jobIdSchema }).strict().readonly();
export type ExportJobReferenceDto = z.output<typeof exportJobReferenceSchema>;

export const exportRenderJobReferenceSchema = z
  .object({ renderJobId: jobIdSchema })
  .strict()
  .readonly();
export type ExportRenderJobReferenceDto = z.output<typeof exportRenderJobReferenceSchema>;

export const exportFrameContextSchema = z
  .object({
    plan: renderPlanSchema,
    mediaUrls: z.record(assetIdSchema, z.string().regex(MEDIA_URL_PATTERN)),
    pointerTracks: z.record(assetIdSchema, pointerTrackSchema.nullable()),
  })
  .strict()
  .readonly();
export type ExportFrameContextDto = z.output<typeof exportFrameContextSchema>;

export const exportFrameRequestSchema = z
  .object({
    exportJobId: jobIdSchema,
    requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    frameIndex: z.number().int().nonnegative().max(1_000_000),
    timelineUs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .readonly();
export type ExportFrameRequestDto = z.output<typeof exportFrameRequestSchema>;

const MAX_EXPORT_FRAME_BYTES = 64 * 1024 * 1024;
const exportFrameBytesSchema = z.custom<Uint8Array>(
  (value) => value instanceof Uint8Array && value.byteLength <= MAX_EXPORT_FRAME_BYTES,
);

export const submitExportFrameRequestSchema = z
  .object({
    exportJobId: jobIdSchema,
    requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    frame: exportFrameBytesSchema.nullable(),
  })
  .strict()
  .readonly();
export type SubmitExportFrameRequestDto = z.output<typeof submitExportFrameRequestSchema>;
