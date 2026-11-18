import { z } from 'zod';

import { canvasStyleSchema } from './canvas';
import { exportPresetIdSchema } from './desktop-export';

/**
 * The user's preferences (docs/state-management.md, "Settings"). Main owns
 * them and keeps them in the OS app-data folder, never in a project; the
 * renderer reads a validated snapshot and changes it only through
 * `updateSettings`. A new shape gets a new `settingsVersion` and a migration.
 */
export const SETTINGS_VERSION = 1;

/**
 * What a new recording starts with. The microphone is deliberately absent:
 * it stays off until the user picks one for each recording
 * (docs/security.md, "Permissions and user intent").
 */
export const recordingDefaultsSchema = z
  .object({
    frameRate: z.union([z.literal(30), z.literal(60)]),
    trackPointer: z.boolean(),
    includeCursor: z.boolean(),
    /** The window minimizes while recording, out of the picture; absent means it does. */
    hideWhileRecording: z.boolean().exactOptional(),
    /** Three seconds are counted down before a recording starts; absent means they are. */
    countdown: z.boolean().exactOptional(),
  })
  .strict()
  .readonly();
export type RecordingDefaults = z.output<typeof recordingDefaultsSchema>;

/** How a new recording's project starts; each stays editable in the project. */
export const newProjectDefaultsSchema = z
  .object({
    autoZoom: z.boolean(),
    zoomScale: z.number().min(1).max(8),
    /** How far the generated camera turns toward each action; 0 keeps it flat. */
    turn3d: z.number().min(0).max(1),
    /** A project's own image is the only image background, so a default never names one. */
    canvas: canvasStyleSchema.refine((style) => style.background.kind !== 'image', {
      message: 'a default canvas cannot use an image background',
    }),
  })
  .strict()
  .readonly();
export type NewProjectDefaults = z.output<typeof newProjectDefaultsSchema>;

export const exportDefaultsSchema = z
  .object({ presetId: exportPresetIdSchema })
  .strict()
  .readonly();
export type ExportDefaults = z.output<typeof exportDefaultsSchema>;

/** How the automatic camera finds where to look, in every project. */
export const analysisSettingsSchema = z
  .object({
    /**
     * It also looks where the picture changes: the editor reads each
     * recording's frames in the background (never keystrokes).
     */
    pictureFocus: z.boolean(),
  })
  .strict()
  .readonly();
export type AnalysisSettings = z.output<typeof analysisSettingsSchema>;

export const appSettingsSchema = z
  .object({
    settingsVersion: z.literal(SETTINGS_VERSION),
    recording: recordingDefaultsSchema,
    newProjects: newProjectDefaultsSchema,
    export: exportDefaultsSchema,
    /** Absent in files from before it existed: the camera then follows the pointer only. */
    analysis: analysisSettingsSchema.exactOptional(),
  })
  .strict()
  .readonly();
export type AppSettings = z.output<typeof appSettingsSchema>;

/** Replaces each section it names, whole; the others stay as they are. */
export const updateSettingsRequestSchema = z
  .object({
    recording: recordingDefaultsSchema.exactOptional(),
    newProjects: newProjectDefaultsSchema.exactOptional(),
    export: exportDefaultsSchema.exactOptional(),
    analysis: analysisSettingsSchema.exactOptional(),
  })
  .strict()
  .readonly();
export type UpdateSettingsRequest = z.output<typeof updateSettingsRequestSchema>;
