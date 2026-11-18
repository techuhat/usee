import { z } from 'zod';

import { analysisRunSchema, autoZoomSettingsSchema } from './analysis';
import { canvasStyleSchema } from './canvas';
import { cursorSettingsSchema, effectSchema } from './effects';
import { appErrorSchema } from './errors';
import { frameRateSchema, pixelSizeSchema } from './geometry';
import {
  assetIdSchema,
  clipIdSchema,
  jobIdSchema,
  projectIdSchema,
  recordingSessionIdSchema,
  trackIdSchema,
} from './ids';
import { durationUsSchema, timestampUsSchema } from './time';

const exportJobStateSchema = z.enum([
  'queued',
  'preparing',
  'rendering',
  'validating',
  'publishing',
  'succeeded',
  'canceled',
  'failed',
]);

const exportPresetSchema = z
  .object({
    id: z.enum(['mp4-h264-1080p30', 'mp4-h264-1080p60', 'mp4-h264-1440p30', 'mp4-h264-4k30']),
    container: z.enum(['mp4', 'webm']),
    codec: z.enum(['h264', 'h265', 'vp9']),
    dimensions: pixelSizeSchema,
    frameRate: frameRateSchema,
    videoBitrateKbps: z.number().int().positive(),
    audioCodec: z.enum(['aac', 'opus']),
    audioBitrateKbps: z.number().int().positive(),
    audioSampleRateHz: z.number().int().positive(),
    hardwarePreference: z.enum(['prefer-hardware', 'software-only']),
  })
  .strict()
  .readonly();

export const renderAssetSchema = z.discriminatedUnion('kind', [
  z
    .object({
      id: assetIdSchema,
      kind: z.literal('video'),
      durationUs: durationUsSchema,
      dimensions: pixelSizeSchema,
      frameRate: frameRateSchema,
      hasAudio: z.boolean(),
    })
    .strict()
    .readonly(),
  z
    .object({
      id: assetIdSchema,
      kind: z.literal('audio'),
      durationUs: durationUsSchema,
      channels: z.number().int().positive(),
      sampleRateHz: z.number().int().positive(),
    })
    .strict()
    .readonly(),
  z
    .object({
      id: assetIdSchema,
      kind: z.literal('event'),
      durationUs: durationUsSchema,
      eventEncoding: z.enum(['jsonl', 'protobuf']),
    })
    .strict()
    .readonly(),
]);

export const renderClipSchema = z
  .object({
    id: clipIdSchema,
    assetId: assetIdSchema,
    sourceStartUs: timestampUsSchema,
    sourceDurationUs: durationUsSchema,
    timelineStartUs: timestampUsSchema,
    timelineDurationUs: durationUsSchema,
    speed: z.number().min(0.25).max(4),
    effects: z.array(effectSchema).max(1_000).readonly(),
    pointer: z
      .object({
        streamAssetId: assetIdSchema,
        sessionId: recordingSessionIdSchema,
        sessionStartUs: timestampUsSchema,
        /** How much older than its timestamp the media's picture is; absent when unknown. */
        captureLatencyUs: z.number().int().min(-250_000).max(250_000).exactOptional(),
      })
      .strict()
      .readonly()
      .nullable(),
  })
  .strict()
  .readonly();
export type RenderClipDto = z.output<typeof renderClipSchema>;

const renderTrackSchema = z
  .object({
    id: trackIdSchema,
    kind: z.enum(['audio', 'effects', 'video']),
    muted: z.boolean(),
    clips: z.array(renderClipSchema).max(10_000).readonly(),
  })
  .strict()
  .readonly();

/** Path-free, versioned render semantics stored with a recoverable export job. */
export const renderPlanSchema = z
  .object({
    planVersion: z.literal(1),
    projectId: projectIdSchema,
    projectUpdatedAtUs: timestampUsSchema,
    durationUs: durationUsSchema,
    frameRate: frameRateSchema,
    preset: exportPresetSchema,
    assets: z.array(renderAssetSchema).max(10_000).readonly(),
    tracks: z.array(renderTrackSchema).max(64).readonly(),
    analysisRuns: z.array(analysisRunSchema).max(10_000).readonly(),
    canvas: canvasStyleSchema,
    cursor: cursorSettingsSchema,
    autoZoom: autoZoomSettingsSchema,
  })
  .strict()
  .readonly();
export type RenderPlanDto = z.output<typeof renderPlanSchema>;
export type RenderAssetDto = z.output<typeof renderAssetSchema>;

const exportJobSchema = z
  .object({
    id: jobIdSchema,
    projectId: projectIdSchema,
    state: z.literal('queued'),
    preset: exportPresetSchema,
    destinationPath: z.string().min(1).max(32_768),
    createdAtUs: timestampUsSchema,
  })
  .strict()
  .readonly();

export const renderJobSchema = z
  .object({
    id: jobIdSchema,
    exportJobId: jobIdSchema,
    state: exportJobStateSchema,
    progress: z.number().min(0).max(1),
    createdAtUs: timestampUsSchema,
  })
  .strict()
  .readonly();
export type RenderJobDto = z.output<typeof renderJobSchema>;

export const exportQueueEntrySchema = z
  .object({
    prepared: z
      .object({
        job: exportJobSchema,
        plan: renderPlanSchema,
        planHash: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict()
      .readonly(),
    update: z
      .object({ job: renderJobSchema, error: appErrorSchema.nullable() })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly()
  .superRefine((entry, context) => {
    if (
      entry.prepared.job.projectId !== entry.prepared.plan.projectId ||
      entry.prepared.job.preset.id !== entry.prepared.plan.preset.id ||
      entry.update.job.exportJobId !== entry.prepared.job.id
    ) {
      context.addIssue({ code: 'custom', message: 'Export job references do not match.' });
    }
    const { state, progress } = entry.update.job;
    const terminal = state === 'succeeded' || state === 'canceled' || state === 'failed';
    if (
      (state === 'queued' && (progress !== 0 || entry.update.error !== null)) ||
      (state === 'succeeded' && (progress !== 1 || entry.update.error !== null)) ||
      (state === 'failed' && entry.update.error === null) ||
      (!terminal && entry.update.error !== null)
    ) {
      context.addIssue({ code: 'custom', message: 'Export job status is inconsistent.' });
    }
  });
export type ExportQueueEntryDto = z.output<typeof exportQueueEntrySchema>;

/** One atomic, bounded snapshot of the desktop user's pending/export history. */
export const exportQueueSnapshotSchema = z
  .object({
    formatVersion: z.literal(1),
    entries: z.array(exportQueueEntrySchema).max(10_000).readonly(),
  })
  .strict()
  .readonly()
  .superRefine((snapshot, context) => {
    const renderJobIds = new Set<string>();
    const exportJobIds = new Set<string>();
    snapshot.entries.forEach((entry, index) => {
      if (renderJobIds.has(entry.update.job.id) || exportJobIds.has(entry.prepared.job.id)) {
        context.addIssue({
          code: 'custom',
          message: 'Export queue IDs must be unique.',
          path: ['entries', index],
        });
      }
      renderJobIds.add(entry.update.job.id);
      exportJobIds.add(entry.prepared.job.id);
    });
  });
export type ExportQueueSnapshotDto = z.output<typeof exportQueueSnapshotSchema>;
