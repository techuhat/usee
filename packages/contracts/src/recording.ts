import { z } from 'zod';

import { appErrorSchema } from './errors';
import {
  hostAudioInputSchema,
  hostDisplaySchema,
  hostRegionSchema,
  hostWindowSchema,
} from './recorder-protocol';

const opaqueId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const microseconds = z.number().int().nonnegative();
const count = z.number().int().nonnegative();
const isoTimestamp = z.iso.datetime();
/** Shown to the user so they can find their recording; never sent anywhere else. */
const projectPath = z.string().min(1).max(1024);

export const recordingSourcesSchema = z
  .object({
    displays: z.array(hostDisplaySchema).readonly(),
    /** The windows open when the list was made, for the picker only (ADR-009). */
    windows: z.array(hostWindowSchema).readonly(),
    audioInputs: z.array(hostAudioInputSchema).readonly(),
  })
  .readonly();
export type RecordingSources = z.output<typeof recordingSourcesSchema>;

/** What a recording captures: a whole display, one window or a region of a display (ADR-009). */
export const captureSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('display'), displayId: opaqueId })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal('window'), windowId: opaqueId })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal('region'), displayId: opaqueId, region: hostRegionSchema })
    .strict()
    .readonly(),
]);
export type CaptureSource = z.output<typeof captureSourceSchema>;

/** The location hash of the area picker, a page of its own window over a display (ADR-009). */
export const REGION_PICKER_HASH = '#region-picker';

export const chooseRegionRequestSchema = z.object({ displayId: opaqueId }).strict().readonly();
export type ChooseRegionRequest = z.output<typeof chooseRegionRequestSchema>;

/** The area chosen, in the display's pixels and inside it, or null when the picker was cancelled. */
export const chosenRegionSchema = z.object({ region: hostRegionSchema.nullable() }).readonly();
export type ChosenRegion = z.output<typeof chosenRegionSchema>;

const cssPixels = z.number().finite().min(0).max(65_536);

/** What the picker page drew, in its CSS pixels, or null to cancel. */
export const regionDrawingSchema = z
  .object({
    area: z
      .object({ x: cssPixels, y: cssPixels, width: cssPixels, height: cssPixels })
      .strict()
      .readonly()
      .nullable(),
  })
  .strict()
  .readonly();
export type RegionDrawing = z.output<typeof regionDrawingSchema>;

export const startRecordingRequestSchema = z
  .object({
    source: captureSourceSchema,
    audioInputId: opaqueId.nullable(),
    frameRate: z.union([z.literal(30), z.literal(60)]),
    /** Draw the OS cursor into the video; ignored when the pointer is recorded. */
    includeCursor: z.boolean(),
    /** Record pointer movement and clicks so the editor can draw the cursor (never keystrokes). */
    trackPointer: z.boolean(),
  })
  .strict()
  .readonly();
export type StartRecordingRequest = z.output<typeof startRecordingRequestSchema>;

export const recordingMetricsSchema = z
  .object({ elapsedUs: microseconds, framesEncoded: count, framesDropped: count })
  .readonly();
export type RecordingMetrics = z.output<typeof recordingMetricsSchema>;

/** The renderer's read-only projection of the recording lifecycle (ADR-005). */
export const recordingStateSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('idle') }).readonly(),
  z.object({ phase: z.literal('preparing'), sessionId: opaqueId }).readonly(),
  z
    .object({
      phase: z.literal('recording'),
      sessionId: opaqueId,
      startedAt: isoTimestamp,
      metrics: recordingMetricsSchema,
      microphone: z.enum(['off', 'on', 'failed']),
      hardwareEncoder: z.boolean(),
    })
    .readonly(),
  z.object({ phase: z.literal('finalizing'), sessionId: opaqueId }).readonly(),
  z
    .object({
      phase: z.literal('completed'),
      sessionId: opaqueId,
      projectPath,
      durationUs: microseconds,
      framesDropped: count,
    })
    .readonly(),
  z
    .object({
      phase: z.literal('failed'),
      sessionId: opaqueId.nullable(),
      error: appErrorSchema,
      /** Set when the segments recorded before the failure were saved. */
      projectPath: projectPath.nullable(),
    })
    .readonly(),
]);
export type RecordingState = z.output<typeof recordingStateSchema>;

export const interruptedRecordingSchema = z
  .object({
    sessionId: opaqueId,
    startedAt: isoTimestamp.nullable(),
    durationUs: microseconds,
    segmentCount: count,
    /** True when the host finished cleanly but the import never completed. */
    finalized: z.boolean(),
  })
  .readonly();
export type InterruptedRecording = z.output<typeof interruptedRecordingSchema>;

export const recoveredRecordingSchema = z
  .object({ sessionId: opaqueId, projectPath, durationUs: microseconds })
  .readonly();
export type RecoveredRecording = z.output<typeof recoveredRecordingSchema>;

export const sessionReferenceSchema = z.object({ sessionId: opaqueId }).strict().readonly();
export type SessionReference = z.output<typeof sessionReferenceSchema>;
