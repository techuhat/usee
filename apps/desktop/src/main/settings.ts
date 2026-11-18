import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { writeFileAtomic } from '@usee/adapter-project-fs';
import {
  appSettingsSchema,
  createAppError,
  err,
  ok,
  SETTINGS_VERSION,
  type AppSettings,
  type CorrelationId,
  type Result,
  type UpdateSettingsRequest,
} from '@usee/contracts';
import {
  DEFAULT_AUTO_ZOOM_SETTINGS,
  DEFAULT_CANVAS_STYLE,
  type AutoZoomSettings,
  type CanvasStyle,
} from '@usee/domain';

import type { Logger } from './logging/logger';

export const SETTINGS_FILE_NAME = 'settings.json';

/** A first start, or an unreadable file: the app as it behaved before it had settings. */
export const DEFAULT_APP_SETTINGS: AppSettings = Object.freeze({
  settingsVersion: SETTINGS_VERSION,
  recording: Object.freeze({ frameRate: 60, trackPointer: true, includeCursor: true }),
  newProjects: Object.freeze({
    autoZoom: DEFAULT_AUTO_ZOOM_SETTINGS.enabled,
    zoomScale: DEFAULT_AUTO_ZOOM_SETTINGS.scale,
    turn3d: 0,
    canvas: DEFAULT_CANVAS_STYLE,
  }),
  export: Object.freeze({ presetId: 'mp4-h264-1080p30' }),
});

/** The settings manager (docs/module-boundaries.md): one validated snapshot, saved atomically. */
export interface Settings {
  current(): AppSettings;
  /** Replaces the sections the request names; the result is validated whole before it is saved. */
  update(request: UpdateSettingsRequest): Promise<Result<AppSettings>>;
  /** Calls `listener` after each saved change; returns a function that removes it. */
  subscribe(listener: (settings: AppSettings) => void): () => void;
}

export interface SettingsOptions {
  /** The OS app-data folder: settings never live in a project (docs/project-format.md). */
  readonly directory: string;
  readonly logger: Logger;
  readonly createCorrelationId: () => CorrelationId;
}

/**
 * Reads the saved settings. A missing file is a first start; a file that is
 * not valid JSON, fails the schema or has another version gives the defaults
 * and a warning, and is replaced on the next change.
 */
async function readSettings(filePath: string, logger: Logger): Promise<AppSettings> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.log('WARN', 'settings.read-failed', 'desktop.settings', {
        errno: (error as NodeJS.ErrnoException).code ?? 'unknown',
      });
    }
    return DEFAULT_APP_SETTINGS;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    logger.log('WARN', 'settings.unreadable', 'desktop.settings', { reason: 'json' });
    return DEFAULT_APP_SETTINGS;
  }
  const parsed = appSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    logger.log('WARN', 'settings.unreadable', 'desktop.settings', { reason: 'schema' });
    return DEFAULT_APP_SETTINGS;
  }
  return parsed.data;
}

export async function loadSettings(options: SettingsOptions): Promise<Settings> {
  const filePath = path.join(options.directory, SETTINGS_FILE_NAME);
  let current = await readSettings(filePath, options.logger);
  // One change at a time, each merged onto the one before it.
  let queue: Promise<unknown> = Promise.resolve();
  const listeners = new Set<(settings: AppSettings) => void>();

  const failure = (code: string) =>
    err(
      createAppError({
        category: 'storage',
        code,
        retryable: code === 'storage.settings-write-failed',
        userMessageKey: `errors.${code}`,
        correlationId: options.createCorrelationId(),
      }),
    );

  return {
    current: () => current,
    update(request) {
      const run = queue.then(async (): Promise<Result<AppSettings>> => {
        const next = appSettingsSchema.safeParse({ ...current, ...request });
        if (!next.success) {
          return failure('storage.settings-invalid');
        }
        try {
          await mkdir(options.directory, { recursive: true });
          await writeFileAtomic(filePath, `${JSON.stringify(next.data, null, 2)}\n`);
        } catch (error) {
          options.logger.log('ERROR', 'settings.write-failed', 'desktop.settings', {
            errno: (error as NodeJS.ErrnoException).code ?? 'unknown',
          });
          return failure('storage.settings-write-failed');
        }
        current = next.data;
        for (const listener of listeners) {
          listener(current);
        }
        return ok(current);
      });
      queue = run;
      return run;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The project-wide looks a new recording starts with (the recording store's `projectLooks`). */
export interface ProjectLooks {
  readonly autoZoom: AutoZoomSettings;
  readonly canvas: CanvasStyle;
}

/** The looks a new recording's project starts with, from the settings. */
export function projectLooksFrom(settings: AppSettings): ProjectLooks {
  const { autoZoom, zoomScale, turn3d, canvas } = settings.newProjects;
  return {
    autoZoom: {
      ...DEFAULT_AUTO_ZOOM_SETTINGS,
      enabled: autoZoom,
      scale: zoomScale,
      ...(turn3d > 0 ? { turn3d } : {}),
    },
    canvas,
  };
}
