import { z } from 'zod';

import {
  analysisRunSchema,
  assetIdSchema,
  autoZoomSettingsSchema,
  canvasStyleSchema,
  clipIdSchema,
  coordinateSpaceSchema,
  cursorSettingsSchema,
  durationUsSchema,
  effectSchema,
  err,
  frameRateSchema,
  jsonValueSchema,
  ok,
  pixelSizeSchema,
  projectIdSchema,
  recordingSessionIdSchema,
  rectangleSchema,
  schemaVersionSchema,
  timelineIdSchema,
  timestampUsSchema,
  trackIdSchema,
  type Result,
  type SchemaVersion,
} from '@usee/contracts';

import { PROJECT_FORMAT_VERSION } from './format-version';
import type { ProjectManifest } from './manifest';
import {
  migrateManifest,
  PROJECT_MIGRATIONS,
  type JsonObject,
  type MigrationFailure,
  type ProjectMigration,
} from './migrations';
import { isSafeRelativePath } from './relative-path';

const relativePath = z
  .string()
  .refine(isSafeRelativePath, { error: 'Unsafe bundle-relative path.' });

const assetBase = {
  id: assetIdSchema,
  createdAtUs: timestampUsSchema,
  durationUs: durationUsSchema,
  relativePath,
};

const mediaAssetSchema = z.discriminatedUnion('kind', [
  z.object({
    ...assetBase,
    kind: z.literal('video'),
    dimensions: pixelSizeSchema,
    frameRate: frameRateSchema,
    hasAudio: z.boolean(),
    sessionStartUs: timestampUsSchema.optional(),
    /** How much older than its timestamp a picture is, as recorded, negative when shown after it (since v10). */
    captureLatencyUs: z.number().int().min(-250_000).max(250_000).exactOptional(),
  }),
  z.object({
    ...assetBase,
    kind: z.literal('audio'),
    channels: z.number().int().positive(),
    sampleRateHz: z.number().int().positive(),
    sessionStartUs: timestampUsSchema.optional(),
  }),
  z.object({
    ...assetBase,
    kind: z.literal('event'),
    eventEncoding: z.enum(['jsonl', 'protobuf']),
  }),
]);

const recordingSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('display'),
    displayId: z.string().min(1).max(64),
    coordinateSpace: coordinateSpaceSchema,
    bounds: rectangleSchema,
  }),
  z.object({
    kind: z.literal('window'),
    windowId: z.string().min(1).max(64),
    coordinateSpace: coordinateSpaceSchema,
  }),
  z.object({
    kind: z.literal('region'),
    coordinateSpace: coordinateSpaceSchema,
    region: rectangleSchema,
  }),
  z.object({ kind: z.literal('webcam'), deviceId: z.string().min(1).max(64) }),
]);

const timeRangeSchema = z.object({ startUs: timestampUsSchema, durationUs: durationUsSchema });

const clipSchema = z.object({
  id: clipIdSchema,
  assetId: assetIdSchema,
  sourceRange: timeRangeSchema,
  timelineStartUs: timestampUsSchema,
  effects: z.array(effectSchema).max(1_000),
  /** How fast the clip plays its source; absent plays it at its own pace. Since v7. */
  speed: z.number().min(0.25).max(4).exactOptional(),
});

/**
 * `manifest.json`, version 2 (docs/project-format.md): version 1 plus clip
 * effects and the project's cursor settings. Older versions reach this
 * shape through PROJECT_MIGRATIONS.
 */
export const projectManifestSchema = z.object({
  manifestVersion: z.literal(11).transform((version) => version as SchemaVersion),
  project: z.object({
    id: projectIdSchema,
    schemaVersion: schemaVersionSchema,
    title: z.string().min(1).max(200),
    createdAtUs: timestampUsSchema,
    updatedAtUs: timestampUsSchema,
    assets: z.array(mediaAssetSchema),
    recordingSessions: z.array(
      z.object({
        id: recordingSessionIdSchema,
        startedAtUs: timestampUsSchema,
        endedAtUs: timestampUsSchema.optional(),
        sources: z.array(recordingSourceSchema),
        videoAssetIds: z.array(assetIdSchema),
        audioAssetIds: z.array(assetIdSchema),
        interactionAssetId: assetIdSchema.optional(),
      }),
    ),
    analysisRuns: z.array(analysisRunSchema).max(1_000),
    timeline: z.object({
      id: timelineIdSchema,
      frameRate: frameRateSchema,
      tracks: z.array(
        z.object({
          id: trackIdSchema,
          kind: z.enum(['audio', 'effects', 'video']),
          muted: z.boolean(),
          clips: z.array(clipSchema),
        }),
      ),
    }),
    settings: z.object({
      defaultFrameRate: frameRateSchema,
      previewQuality: z.enum(['draft', 'full']),
      colorSpace: z.enum(['sdr', 'hdr']),
      cursor: cursorSettingsSchema,
      autoZoom: autoZoomSettingsSchema,
      canvas: canvasStyleSchema,
    }),
  }),
  managedAssetPaths: z.record(z.string(), relativePath),
  metadata: z.record(z.string(), jsonValueSchema),
});

// Every current-version manifest the domain can express must pass the schema. (The
// reverse holds by construction: decode only returns validated values.)
type AssertAssignable<Target, Source extends Target> = Source;
type DeepReadonly<T> = T extends readonly (infer Element)[]
  ? readonly DeepReadonly<Element>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;
export type ManifestMatchesSchema = AssertAssignable<
  DeepReadonly<z.input<typeof projectManifestSchema>>,
  Omit<ProjectManifest, 'manifestVersion'> & { readonly manifestVersion: 11 }
>;

export function encodeManifest(manifest: ProjectManifest): Result<string> {
  return ok(`${JSON.stringify(manifest, null, 2)}\n`);
}

/** Parses and validates a current-version `manifest.json`; any other version fails closed. */
export function decodeManifest(serialized: string): Result<ProjectManifest, string> {
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch {
    return err('manifest is not valid JSON');
  }
  return validateManifest(raw);
}

function validateManifest(raw: unknown): Result<ProjectManifest, string> {
  const parsed = projectManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return err(parsed.error.issues[0]?.message ?? 'manifest is invalid');
  }
  // Validated above; optional fields differ only in carrying explicit `undefined`.
  return ok(parsed.data as ProjectManifest);
}

export type ManifestReadFailure =
  { readonly reason: 'invalid'; readonly detail: string } | MigrationFailure;

export interface ReadManifestResult {
  readonly manifest: ProjectManifest;
  /** The version on disk when it was older and has been migrated in memory. */
  readonly migratedFrom: number | null;
}

/**
 * Opens a manifest of any supported version: older ones are migrated to the
 * current version (the caller persists that), newer ones fail closed.
 */
export function readManifest(
  serialized: string,
  migrations: readonly ProjectMigration[] = PROJECT_MIGRATIONS,
): Result<ReadManifestResult, ManifestReadFailure> {
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch {
    return err({ reason: 'invalid', detail: 'manifest is not valid JSON' });
  }
  const json = jsonValueSchema.safeParse(raw);
  if (
    !json.success ||
    typeof json.data !== 'object' ||
    json.data === null ||
    Array.isArray(json.data)
  ) {
    return err({ reason: 'invalid', detail: 'manifest is not a JSON object' });
  }
  const migrated = migrateManifest(json.data as JsonObject, PROJECT_FORMAT_VERSION, migrations);
  if (!migrated.ok) {
    return migrated;
  }
  const decoded = validateManifest(migrated.value.manifest);
  if (!decoded.ok) {
    return err({ reason: 'invalid', detail: decoded.error });
  }
  const { fromVersion } = migrated.value;
  return ok({
    manifest: decoded.value,
    migratedFrom: fromVersion === PROJECT_FORMAT_VERSION ? null : fromVersion,
  });
}
