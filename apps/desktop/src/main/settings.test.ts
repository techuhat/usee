import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { asCorrelationId } from '@usee/contracts';

import type { Logger, LogLevel } from './logging/logger';
import {
  DEFAULT_APP_SETTINGS,
  loadSettings,
  projectLooksFrom,
  SETTINGS_FILE_NAME,
} from './settings';

const gradient = { kind: 'gradient', from: '#1b2550', to: '#6d3bd1', angle: 135 } as const;

describe('the settings manager', () => {
  let directory = '';
  let logged: { level: LogLevel; event: string }[] = [];
  const logger: Logger = { log: (level, event) => logged.push({ level, event }) };
  const load = () =>
    loadSettings({
      directory,
      logger,
      createCorrelationId: () => asCorrelationId('settings-test'),
    });
  const saved = async () =>
    JSON.parse(await readFile(path.join(directory, SETTINGS_FILE_NAME), 'utf8')) as unknown;

  beforeEach(async () => {
    directory = path.join(await mkdtemp(path.join(tmpdir(), 'usee-settings-')), 'user-data');
    logged = [];
  });

  afterEach(async () => {
    await rm(path.dirname(directory), { recursive: true, force: true });
  });

  it('starts from the defaults, which keep the app as it was before settings', async () => {
    const settings = await load();
    expect(settings.current()).toEqual(DEFAULT_APP_SETTINGS);
    expect(logged).toEqual([]);
    // A project from these looks is a project from the built-in defaults.
    expect(projectLooksFrom(settings.current())).toEqual({
      autoZoom: { enabled: true, scale: 2, disabled: [] },
      canvas: DEFAULT_APP_SETTINGS.newProjects.canvas,
    });
  });

  it('saves a change and reads it back on the next start', async () => {
    const settings = await load();
    const newProjects = {
      ...DEFAULT_APP_SETTINGS.newProjects,
      turn3d: 0.6,
      canvas: { ...DEFAULT_APP_SETTINGS.newProjects.canvas, background: gradient, padding: 0.08 },
    };
    const updated = await settings.update({ newProjects });
    expect(updated.ok && updated.value.newProjects).toEqual(newProjects);
    expect(await saved()).toEqual({ ...DEFAULT_APP_SETTINGS, newProjects });

    const reloaded = await load();
    expect(reloaded.current().newProjects).toEqual(newProjects);
    expect(projectLooksFrom(reloaded.current()).autoZoom.turn3d).toBe(0.6);
  });

  it('keeps every change when several arrive together', async () => {
    const settings = await load();
    const recording = { frameRate: 30, trackPointer: false, includeCursor: true } as const;
    const exported = { presetId: 'mp4-h264-4k30' } as const;
    await Promise.all([settings.update({ recording }), settings.update({ export: exported })]);
    expect(settings.current()).toMatchObject({ recording, export: exported });
    expect(await saved()).toMatchObject({ recording, export: exported });
  });

  it('falls back to the defaults, with a warning, for a damaged or foreign file', async () => {
    await mkdir(directory, { recursive: true });
    for (const contents of ['{ not json', JSON.stringify({ settingsVersion: 99 })]) {
      await writeFile(path.join(directory, SETTINGS_FILE_NAME), contents);
      logged = [];
      expect((await load()).current()).toEqual(DEFAULT_APP_SETTINGS);
      expect(logged).toEqual([{ level: 'WARN', event: 'settings.unreadable' }]);
    }
  });

  it('refuses a change that would make the settings invalid, and saves nothing', async () => {
    const settings = await load();
    const newProjects = { ...DEFAULT_APP_SETTINGS.newProjects, turn3d: 2 };
    const result = await settings.update({ newProjects });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('storage.settings-invalid');
    expect(settings.current()).toEqual(DEFAULT_APP_SETTINGS);
  });
});
