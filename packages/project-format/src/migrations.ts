import { err, ok, type JsonValue, type Result } from '@usee/contracts';
import { DEFAULT_AUTO_ZOOM_SETTINGS, DEFAULT_CANVAS_STYLE } from '@usee/domain';

export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * One pure step from a `fromVersion` manifest to a `fromVersion + 1` one.
 * Steps take and return raw JSON, because an older manifest is not the
 * current type; the last step's output is checked by the current schema.
 * Migrations never perform I/O: the repository backs up, writes, validates
 * and renames around them (docs/project-format.md).
 */
export interface ProjectMigration {
  readonly fromVersion: number;
  readonly migrate: (manifest: JsonObject) => Result<JsonObject, string>;
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isList(value: JsonValue | undefined): value is readonly JsonValue[] {
  return Array.isArray(value);
}

/** v1 → v2 (Phase 3): clips may carry effects, and the project gains cursor settings. */
const addCursorSettings: ProjectMigration = {
  fromVersion: 1,
  migrate: (manifest) => {
    const project = manifest['project'];
    const settings = isObject(project) ? project['settings'] : undefined;
    if (!isObject(project) || !isObject(settings)) {
      return err('version 1 manifest without project settings');
    }
    // The defaults as version 2 wrote them; later steps carry them forward.
    const cursor = { visible: true, size: 1.5, smoothing: 0.5, clickEffect: true };
    return ok({
      ...manifest,
      manifestVersion: 2,
      project: { ...project, settings: { ...settings, cursor } },
    });
  },
};

/** The zoom effects of every clip, changed by `change`; undefined when the timeline is malformed. */
function mapZooms(
  project: JsonObject,
  change: (zoom: JsonObject) => JsonObject,
): JsonObject | undefined {
  const timeline = project['timeline'];
  const tracks = isObject(timeline) ? timeline['tracks'] : undefined;
  if (!isObject(timeline) || !isList(tracks)) {
    return undefined;
  }
  return {
    ...project,
    timeline: {
      ...timeline,
      tracks: tracks.map((track) =>
        isObject(track) && isList(track['clips'])
          ? {
              ...track,
              clips: track['clips'].map((clip) =>
                isObject(clip) && isList(clip['effects'])
                  ? {
                      ...clip,
                      effects: clip['effects'].map((effect) =>
                        isObject(effect) && effect['kind'] === 'zoom' ? change(effect) : effect,
                      ),
                    }
                  : clip,
              ),
            }
          : track,
      ),
    },
  };
}

/** v2 → v3 (Phase 3): a zoom's one pose becomes its first keyframe, at the zoom's start. */
const keyframeZoomPoses: ProjectMigration = {
  fromVersion: 2,
  migrate: (manifest) => {
    const project = manifest['project'];
    const migrated = isObject(project)
      ? mapZooms(project, ({ pose, ...zoom }) => {
          const range = zoom['range'];
          const startUs = isObject(range) ? (range['startUs'] ?? 0) : 0;
          return pose === undefined
            ? zoom
            : { ...zoom, poses: [{ timestampUs: startUs, value: pose, easing: 'ease-in-out' }] };
        })
      : undefined;
    return migrated === undefined
      ? err('version 2 manifest without a timeline')
      : ok({ ...manifest, manifestVersion: 3, project: migrated });
  },
};

/** v3 → v4 (Phase 4): generated camera tracks (none yet) and the auto-zoom settings. */
const addCameraAnalysis: ProjectMigration = {
  fromVersion: 3,
  migrate: (manifest) => {
    const project = manifest['project'];
    const settings = isObject(project) ? project['settings'] : undefined;
    if (!isObject(project) || !isObject(settings)) {
      return err('version 3 manifest without project settings');
    }
    return ok({
      ...manifest,
      manifestVersion: 4,
      project: {
        ...project,
        analysisRuns: [],
        settings: {
          ...settings,
          autoZoom: { ...DEFAULT_AUTO_ZOOM_SETTINGS, disabled: [] },
        },
      },
    });
  },
};

/** v4 → v5: a click shows in one of several styles; shown clicks were ripples. */
const chooseClickEffect: ProjectMigration = {
  fromVersion: 4,
  migrate: (manifest) => {
    const project = manifest['project'];
    const settings = isObject(project) ? project['settings'] : undefined;
    const cursor = isObject(settings) ? settings['cursor'] : undefined;
    if (!isObject(project) || !isObject(settings) || !isObject(cursor)) {
      return err('version 4 manifest without cursor settings');
    }
    const shown = cursor['clickEffect'];
    return ok({
      ...manifest,
      manifestVersion: 5,
      project: {
        ...project,
        settings: {
          ...settings,
          cursor: { ...cursor, clickEffect: shown === false ? 'none' : 'ripple' },
        },
      },
    });
  },
};

/** v5 → v6 (Phase 5): the project gains the default output canvas style. */
const addCanvasStyle: ProjectMigration = {
  fromVersion: 5,
  migrate: (manifest) => {
    const project = manifest['project'];
    const settings = isObject(project) ? project['settings'] : undefined;
    if (!isObject(project) || !isObject(settings)) {
      return err('version 5 manifest without project settings');
    }
    return ok({
      ...manifest,
      manifestVersion: 6,
      project: {
        ...project,
        settings: {
          ...settings,
          canvas: JSON.parse(JSON.stringify(DEFAULT_CANVAS_STYLE)) as JsonObject,
        },
      },
    });
  },
};

/**
 * v6 → v7 (Phase 5): a clip may play faster or slower. Clips without a speed
 * play at their own pace, so nothing changes but the version: an older build
 * then refuses the project rather than dropping the speeds it cannot read.
 */
const allowClipSpeed: ProjectMigration = {
  fromVersion: 6,
  migrate: (manifest) => ok({ ...manifest, manifestVersion: 7 }),
};

/**
 * v7 → v8 (Phase 5): the cursor may have a colour and a spotlight, and the
 * canvas a motion blur, all optional; only the version changes, so an older
 * build refuses the project rather than dropping what it cannot read.
 */
const allowCursorLookAndMotionBlur: ProjectMigration = {
  fromVersion: 7,
  migrate: (manifest) => ok({ ...manifest, manifestVersion: 8 }),
};

/**
 * v8 → v9 (Phase 6): a zoom's camera flows through its keyframes unless one
 * holds, and before this every keyframe held; so each existing keyframe is
 * marked as holding, and old projects move exactly as they did. Poses may
 * pull back, zooms may have a lens and the generated camera may turn, all
 * optional.
 */
const holdExistingKeyframes: ProjectMigration = {
  fromVersion: 8,
  migrate: (manifest) => {
    const project = manifest['project'];
    if (!isObject(project)) {
      return err('version 8 manifest without a project');
    }
    const migrated = mapZooms(project, (zoom) => {
      const poses = zoom['poses'];
      return isList(poses)
        ? { ...zoom, poses: poses.map((pose) => (isObject(pose) ? { ...pose, hold: true } : pose)) }
        : zoom;
    });
    if (migrated === undefined) {
      return err('version 8 manifest without a timeline');
    }
    return ok({ ...manifest, manifestVersion: 9, project: migrated });
  },
};

/**
 * v9 → v10 (Phase 8): a canvas may use the current recording as a blurred
 * backdrop. Existing backgrounds remain valid; changing the version makes an
 * older build refuse a project instead of silently losing that new choice.
 */
const allowBlurredSourceBackdrop: ProjectMigration = {
  fromVersion: 9,
  migrate: (manifest) => ok({ ...manifest, manifestVersion: 10 }),
};

/**
 * v10 → v11 (Phase 8): a clip may carry annotations (ADR-011). Existing
 * effects remain valid; the version makes an older build refuse a project
 * with annotations instead of failing on an effect it does not know.
 */
const allowAnnotations: ProjectMigration = {
  fromVersion: 10,
  migrate: (manifest) => ok({ ...manifest, manifestVersion: 11 }),
};

/** Every migration, oldest first. */
export const PROJECT_MIGRATIONS: readonly ProjectMigration[] = Object.freeze([
  addCursorSettings,
  keyframeZoomPoses,
  addCameraAnalysis,
  chooseClickEffect,
  addCanvasStyle,
  allowClipSpeed,
  allowCursorLookAndMotionBlur,
  holdExistingKeyframes,
  allowBlurredSourceBackdrop,
  allowAnnotations,
]);

export type MigrationFailure =
  | { readonly reason: 'version-missing' }
  /** Written by a newer build: never guessed at, the user needs that build. */
  | { readonly reason: 'version-newer'; readonly version: number }
  | { readonly reason: 'migration-missing'; readonly version: number }
  | { readonly reason: 'migration-failed'; readonly version: number; readonly detail: string };

export interface MigratedManifest {
  readonly manifest: JsonObject;
  readonly fromVersion: number;
}

/** Runs the steps from the manifest's own version up to `targetVersion`, in order. */
export function migrateManifest(
  manifest: JsonObject,
  targetVersion: number,
  migrations: readonly ProjectMigration[] = PROJECT_MIGRATIONS,
): Result<MigratedManifest, MigrationFailure> {
  const fromVersion = manifest['manifestVersion'];
  if (typeof fromVersion !== 'number' || !Number.isSafeInteger(fromVersion) || fromVersion < 1) {
    return err({ reason: 'version-missing' });
  }
  if (fromVersion > targetVersion) {
    return err({ reason: 'version-newer', version: fromVersion });
  }

  let current = manifest;
  for (let version = fromVersion; version < targetVersion; version += 1) {
    const step = migrations.find((migration) => migration.fromVersion === version);
    if (step === undefined) {
      return err({ reason: 'migration-missing', version });
    }
    const next = step.migrate(current);
    if (!next.ok) {
      return err({ reason: 'migration-failed', version, detail: next.error });
    }
    if (next.value['manifestVersion'] !== version + 1) {
      return err({ reason: 'migration-failed', version, detail: 'wrong manifestVersion' });
    }
    current = next.value;
  }
  return ok({ manifest: current, fromVersion });
}
