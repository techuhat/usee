import { z } from 'zod';

import { pointSchema } from './geometry';
import { opaqueIdSchema, recordingSessionIdSchema } from './ids';
import { durationUsSchema, timestampUsSchema } from './time';

/**
 * The persisted and wire shape of generated camera tracks and the auto-zoom
 * settings (Phase 4, focus intelligence). The semantic types are in
 * packages/domain (focus.ts, analysis.ts).
 */

const rampUs = z.number().int().nonnegative().max(3_600_000_000);

/** A zoom the camera planner proposed, in session time. */
export const generatedZoomSchema = z
  .object({
    id: opaqueIdSchema,
    startUs: timestampUsSchema,
    durationUs: durationUsSchema,
    poses: z
      .array(z.object({ timestampUs: timestampUsSchema, anchor: pointSchema }).readonly())
      .min(1)
      .max(1_000)
      .readonly(),
    easeInUs: rampUs,
    easeOutUs: rampUs,
  })
  .readonly();
export type GeneratedZoomDto = z.output<typeof generatedZoomSchema>;

export const autoZoomSettingsSchema = z
  .object({
    enabled: z.boolean(),
    scale: z.number().min(1).max(8),
    disabled: z.array(opaqueIdSchema).max(10_000).readonly(),
    /** How far the generated camera turns toward each action, 0-1; flat when absent (since v9). */
    turn3d: z.number().min(0).max(1).exactOptional(),
  })
  .readonly();
export type AutoZoomSettingsDto = z.output<typeof autoZoomSettingsSchema>;

/** A generated track with its provenance: what made it, from which input, when. */
export const analysisRunSchema = z
  .object({
    kind: z.literal('camera-track'),
    id: opaqueIdSchema,
    sessionId: recordingSessionIdSchema,
    provenance: z
      .object({
        strategy: z.string().min(1).max(64),
        strategyVersion: z.number().int().positive(),
        producer: z.string().min(1).max(128),
        inputSha256: z.string().regex(/^[0-9a-f]{64}$/),
        generatedAt: z.iso.datetime(),
      })
      .readonly(),
    zooms: z.array(generatedZoomSchema).max(10_000).readonly(),
  })
  .readonly();
export type AnalysisRunDto = z.output<typeof analysisRunSchema>;
