import { z } from 'zod';

import { pointSchema, rectangleSchema } from './geometry';
import { effectIdSchema } from './ids';
import { jsonValueSchema } from './json';
import { durationUsSchema, timestampUsSchema } from './time';

/**
 * The persisted and wire shape of clip effects and cursor settings, shared by
 * the project manifest (packages/project-format) and IPC snapshots. The
 * semantic types and their cross-field rules are in packages/domain (effects.ts,
 * effect-rules.ts); these schemas bound every field on its own.
 */

const easingSchema = z.enum(['linear', 'ease-in', 'ease-out', 'ease-in-out']);
const timeRangeSchema = z
  .object({ startUs: timestampUsSchema, durationUs: durationUsSchema })
  .readonly();
const rampUs = z.number().int().nonnegative().max(3_600_000_000);

export const blurRegionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rectangle'), bounds: rectangleSchema }).readonly(),
  z.object({ kind: z.literal('ellipse'), bounds: rectangleSchema }).readonly(),
  z
    .object({ kind: z.literal('polygon'), points: z.array(pointSchema).min(3).max(64).readonly() })
    .readonly(),
]);

const effectBase = { id: effectIdSchema, range: timeRangeSchema, enabled: z.boolean() };

const colourSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const annotationLine = z.number().min(0.002).max(0.03);

/** What an annotation draws, in the frame's normalized coordinates (since manifest v11, ADR-011). */
export const annotationShapeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('text'),
      text: z.string().min(1).max(120),
      at: pointSchema,
      size: z.number().min(0.02).max(0.2),
      color: colourSchema,
      background: z.boolean(),
    })
    .readonly(),
  z
    .object({
      kind: z.literal('arrow'),
      from: pointSchema,
      to: pointSchema,
      lineWidth: annotationLine,
      color: colourSchema,
    })
    .readonly(),
  z
    .object({
      kind: z.literal('box'),
      bounds: rectangleSchema,
      lineWidth: annotationLine,
      color: colourSchema,
    })
    .readonly(),
]);
export type AnnotationShapeDto = z.output<typeof annotationShapeSchema>;

const turnDegrees = z.number().min(-30).max(30);

/**
 * A camera pose; `rotation` turns the picture in 3D (degrees), and is left out
 * when flat. A scale under 1 pulls back from the picture (since manifest v9).
 */
const zoomPoseSchema = z
  .object({
    anchor: pointSchema,
    scale: z.number().min(0.5).max(8),
    rotation: z
      .object({ x: turnDegrees, y: turnDegrees, z: turnDegrees })
      .readonly()
      .exactOptional(),
  })
  .readonly();

export const effectSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...effectBase,
      kind: z.literal('zoom'),
      poses: z
        .array(
          z
            .object({
              timestampUs: timestampUsSchema,
              value: zoomPoseSchema,
              easing: easingSchema,
              /** The camera stops here rather than flowing through (since manifest v9). */
              hold: z.boolean().exactOptional(),
            })
            .readonly(),
        )
        .min(1)
        .max(256)
        .readonly(),
      easeInUs: rampUs,
      easeOutUs: rampUs,
      easing: easingSchema,
      /** The lens's vertical field of view, degrees; 30 when absent (since manifest v9). */
      lens: z.number().min(15).max(60).exactOptional(),
    })
    .readonly(),
  z
    .object({
      ...effectBase,
      kind: z.literal('blur'),
      regions: z
        .array(
          z
            .object({
              timestampUs: timestampUsSchema,
              value: z.array(blurRegionSchema).min(1).max(16).readonly(),
              easing: easingSchema,
            })
            .readonly(),
        )
        .min(1)
        .max(256)
        .readonly(),
      intensity: z.number().positive().max(0.2),
    })
    .readonly(),
  z
    .object({ ...effectBase, kind: z.literal('annotation'), shape: annotationShapeSchema })
    .readonly(),
  z
    .object({
      ...effectBase,
      kind: z.literal('custom'),
      type: z.string().min(1).max(64),
      parameters: z.record(z.string(), jsonValueSchema).readonly(),
    })
    .readonly(),
]);
export type EffectDto = z.output<typeof effectSchema>;

export const cursorSettingsSchema = z
  .object({
    visible: z.boolean(),
    size: z.number().min(0.5).max(3),
    smoothing: z.number().min(0).max(1),
    clickEffect: z.enum(['none', 'ripple', 'pulse', 'ring', 'bounce']),
    color: colourSchema.exactOptional(),
    spotlight: z.number().min(0).max(1).exactOptional(),
  })
  .readonly();
export type CursorSettingsDto = z.output<typeof cursorSettingsSchema>;
