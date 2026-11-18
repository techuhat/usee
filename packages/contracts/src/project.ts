import { z } from 'zod';

import { autoZoomSettingsSchema, generatedZoomSchema } from './analysis';
import { canvasStyleSchema } from './canvas';
import { cursorSettingsSchema, effectSchema } from './effects';
import { appErrorSchema } from './errors';
import { frameRateSchema } from './geometry';
import {
  assetIdSchema,
  clipIdSchema,
  effectIdSchema,
  opaqueIdSchema,
  projectIdSchema,
  trackIdSchema,
} from './ids';
import { durationUsSchema, timestampUsSchema } from './time';

const count = z.number().int().nonnegative();
const isoTimestamp = z.iso.datetime();
const projectPath = z.string().min(1).max(1_024);

/** A project bundle in the projects folder. */
/** A project's thumbnail as the list shows it: a small JPEG, inline. */
const thumbnailDataUrl = z
  .string()
  .max(200_000)
  .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/);

export const projectSummarySchema = z
  .object({
    projectPath,
    title: z.string().min(1).max(200),
    modifiedAt: isoTimestamp,
    /** Only the newest projects carry theirs, so the list stays small. */
    thumbnail: thumbnailDataUrl.exactOptional(),
  })
  .readonly();

/** At most this many bytes of JPEG: a 320 x 180 picture needs far fewer. */
export const MAX_THUMBNAIL_BYTES = 120_000;

export const saveProjectThumbnailRequestSchema = z
  .object({
    jpeg: z.custom<Uint8Array>(
      (value) =>
        value instanceof Uint8Array &&
        value.byteLength >= 3 &&
        value.byteLength <= MAX_THUMBNAIL_BYTES &&
        value[0] === 0xff &&
        value[1] === 0xd8 &&
        value[2] === 0xff,
    ),
  })
  .strict()
  .readonly();
export type SaveProjectThumbnailRequest = z.output<typeof saveProjectThumbnailRequestSchema>;
export type ProjectSummary = z.output<typeof projectSummarySchema>;

export const projectReferenceSchema = z.object({ projectPath }).readonly();
export type ProjectReference = z.output<typeof projectReferenceSchema>;

/** An hour of trim either way per gesture is far beyond any real drag. */
const MAX_TRIM_US = 3_600_000_000;

/** The renderer's edits, the same semantic commands the domain applies (ProjectCommand). */
export const projectCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('split'), clipId: clipIdSchema, atUs: timestampUsSchema }),
  z.object({ type: z.literal('delete'), clipId: clipIdSchema }),
  z.object({
    type: z.literal('trim'),
    clipId: clipIdSchema,
    edge: z.enum(['start', 'end']),
    deltaUs: z.number().int().min(-MAX_TRIM_US).max(MAX_TRIM_US),
  }),
  z.object({ type: z.literal('add-effect'), clipId: clipIdSchema, effect: effectSchema }),
  z.object({ type: z.literal('update-effect'), clipId: clipIdSchema, effect: effectSchema }),
  z.object({ type: z.literal('remove-effect'), clipId: clipIdSchema, effectId: effectIdSchema }),
  z.object({
    type: z.literal('set-clip-speed'),
    clipId: clipIdSchema,
    speed: z.number().min(0.25).max(4),
  }),
  z.object({ type: z.literal('set-cursor'), settings: cursorSettingsSchema }),
  z.object({ type: z.literal('set-canvas'), style: canvasStyleSchema }),
  z.object({
    type: z.literal('set-auto-zoom'),
    enabled: z.boolean(),
    scale: z.number().min(1).max(8),
    turn3d: z.number().min(0).max(1).exactOptional(),
  }),
  z.object({ type: z.literal('set-generated-zoom'), zoomId: opaqueIdSchema, enabled: z.boolean() }),
  z.object({
    type: z.literal('take-over-generated-zoom'),
    zoomId: opaqueIdSchema,
    effects: z
      .array(z.object({ clipId: clipIdSchema, effect: effectSchema }).readonly())
      .min(1)
      .max(1_000)
      .readonly(),
  }),
]);
export type ProjectCommandRequest = z.output<typeof projectCommandSchema>;

export const editProjectRequestSchema = z.object({ command: projectCommandSchema }).readonly();
export type EditProjectRequest = z.output<typeof editProjectRequestSchema>;

/**
 * Where the renderer loads an asset's media: `app://media/<token>/<asset id>`,
 * served only for the open project, with a token that changes per open.
 */
export const MEDIA_URL_PATTERN = /^app:\/\/media\/[0-9a-f]{32}\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export const projectSnapshotSchema = z
  .object({
    projectId: projectIdSchema,
    title: z.string().min(1).max(200),
    /** Grows with every change; a snapshot with a lower revision is stale. */
    revision: count,
    canUndo: z.boolean(),
    canRedo: z.boolean(),
    saveState: z.enum(['saved', 'saving', 'failed']),
    saveError: appErrorSchema.nullable(),
    frameRate: frameRateSchema,
    durationUs: durationUsSchema,
    cursor: cursorSettingsSchema,
    /** The generated camera layer: whether it shows, its scale, the zooms turned off. */
    autoZoom: autoZoomSettingsSchema,
    /** The output canvas: background, padding, corners, shadow, aspect. */
    canvas: canvasStyleSchema,
    /** Whether a recording session kept a pointer stream, so the cursor can be drawn. */
    hasPointer: z.boolean(),
    assets: z
      .array(
        z
          .object({
            id: assetIdSchema,
            kind: z.enum(['video', 'audio']),
            durationUs: durationUsSchema,
            /** A video asset with its own audio; always true for audio assets. */
            hasAudio: z.boolean(),
            mediaUrl: z.string().regex(MEDIA_URL_PATTERN),
            /**
             * The pointer stream recorded with this media, for drawing the
             * cursor, where the media's time zero falls on its clock, and the
             * zooms generated from it (session time).
             */
            pointer: z
              .object({
                streamId: assetIdSchema,
                sessionStartUs: timestampUsSchema,
                /**
                 * How much older than its timestamp the media's picture is,
                 * negative when shown after it; 0 for unknown or audio.
                 */
                captureLatencyUs: z.number().int().min(-250_000).max(250_000),
                autoZooms: z.array(generatedZoomSchema).max(10_000).readonly(),
              })
              .readonly()
              .nullable(),
          })
          .readonly(),
      )
      .max(10_000)
      .readonly(),
    tracks: z
      .array(
        z
          .object({
            id: trackIdSchema,
            kind: z.enum(['audio', 'effects', 'video']),
            muted: z.boolean(),
            clips: z
              .array(
                z
                  .object({
                    id: clipIdSchema,
                    assetId: assetIdSchema,
                    sourceStartUs: timestampUsSchema,
                    durationUs: durationUsSchema,
                    timelineStartUs: timestampUsSchema,
                    /** How fast the clip plays its source; 1 is its own pace. */
                    speed: z.number().min(0.25).max(4),
                    effects: z.array(effectSchema).max(1_000).readonly(),
                  })
                  .readonly(),
              )
              .max(10_000)
              .readonly(),
          })
          .readonly(),
      )
      .max(64)
      .readonly(),
  })
  .readonly();
export type ProjectSnapshot = z.output<typeof projectSnapshotSchema>;

export const assetReferenceSchema = z.object({ assetId: assetIdSchema }).readonly();
export type AssetReference = z.output<typeof assetReferenceSchema>;

export const waveformRequestSchema = assetReferenceSchema;
export type WaveformRequest = z.output<typeof waveformRequestSchema>;

/** Peak amplitudes 0-255, `peaksPerSecond` of them per second, base64-encoded. */
export const waveformSchema = z
  .object({
    peaksPerSecond: z.number().int().min(1).max(1_000),
    peaks: z
      .string()
      .max(4_800_000)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  })
  .readonly();
export type Waveform = z.output<typeof waveformSchema>;
