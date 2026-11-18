import { z } from 'zod';

import { opaqueIdSchema } from './ids';

/**
 * The persisted and wire shape of the output canvas style (Phase 5). The
 * semantic type is CanvasStyle in packages/domain (canvas.ts).
 */

const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);

export const aspectRatioSchema = z.enum(['source', '16:9', '9:16', '1:1', '4:5']);

export const canvasBackgroundSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('solid'), color: colorSchema }).readonly(),
  z
    .object({
      kind: z.literal('gradient'),
      from: colorSchema,
      to: colorSchema,
      angle: z.number().min(0).max(360),
    })
    .readonly(),
  z.object({ kind: z.literal('blurred-source'), blur: z.number().min(0.01).max(0.15) }).readonly(),
  z.object({ kind: z.literal('image'), assetId: opaqueIdSchema }).readonly(),
]);

export const canvasStyleSchema = z
  .object({
    aspect: aspectRatioSchema,
    background: canvasBackgroundSchema,
    padding: z.number().min(0).max(0.4),
    cornerRadius: z.number().min(0).max(0.5),
    shadow: z
      .object({
        opacity: z.number().min(0).max(1),
        blur: z.number().min(0).max(0.2),
        offsetY: z.number().min(-0.1).max(0.1),
      })
      .readonly(),
    motionBlur: z.number().min(0).max(1).exactOptional(),
  })
  .readonly();
export type CanvasStyleDto = z.output<typeof canvasStyleSchema>;
