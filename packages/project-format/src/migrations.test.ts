import { describe, expect, it } from 'vitest';

import { asProjectId, asRecordingSessionId, err, ok } from '@usee/contracts';

import { MANIFEST_V1 } from './fixtures/manifest-v1';
import { MANIFEST_V2 } from './fixtures/manifest-v2';
import { encodeManifest, readManifest } from './manifest-schema';
import { migrateManifest, type JsonObject, type ProjectMigration } from './migrations';
import { createRecordingProject } from './recording-project';

// Fixture steps: v1 → v2 renames `title` to `name`, v2 → v3 adds `tags`.
const fixtures: readonly ProjectMigration[] = [
  {
    fromVersion: 2,
    migrate: (manifest) => ok({ ...manifest, manifestVersion: 3, tags: [] }),
  },
  {
    fromVersion: 1,
    migrate: ({ title, ...rest }) => ok({ ...rest, manifestVersion: 2, name: title ?? null }),
  },
];

const v1: JsonObject = { manifestVersion: 1, title: 'Demo' };

describe('migrateManifest', () => {
  it('runs each step in version order up to the target', () => {
    expect(migrateManifest(v1, 3, fixtures)).toEqual(
      ok({ manifest: { manifestVersion: 3, name: 'Demo', tags: [] }, fromVersion: 1 }),
    );
  });

  it('leaves a current manifest untouched', () => {
    expect(migrateManifest(v1, 1, fixtures)).toEqual(ok({ manifest: v1, fromVersion: 1 }));
  });

  it('fails closed on a version newer than this build', () => {
    expect(migrateManifest({ manifestVersion: 4 }, 3, fixtures)).toEqual(
      err({ reason: 'version-newer', version: 4 }),
    );
  });

  it('reports a missing version, a missing step and a failing step', () => {
    expect(migrateManifest({ title: 'x' }, 3, fixtures)).toEqual(
      err({ reason: 'version-missing' }),
    );
    expect(migrateManifest(v1, 3, fixtures.slice(0, 1))).toEqual(
      err({ reason: 'migration-missing', version: 1 }),
    );
    const failing: ProjectMigration = { fromVersion: 1, migrate: () => err('bad clip') };
    expect(migrateManifest(v1, 2, [failing])).toEqual(
      err({ reason: 'migration-failed', version: 1, detail: 'bad clip' }),
    );
    const skipping: ProjectMigration = {
      fromVersion: 1,
      migrate: (manifest) => ok({ ...manifest, manifestVersion: 3 }),
    };
    expect(migrateManifest(v1, 3, [skipping])).toMatchObject({
      ok: false,
      error: { reason: 'migration-failed', version: 1 },
    });
  });
});

describe('readManifest', () => {
  const manifest = createRecordingProject({
    projectId: asProjectId('project-1'),
    title: 'Recording',
    createdAtUs: 1_792_000_000_000_000,
    sessionId: asRecordingSessionId('session-1'),
    source: { kind: 'display', displayId: 'display-0a1b2c3d' },
    video: { width: 1920, height: 1080 },
    frameRate: { numerator: 60, denominator: 1 },
    audio: null,
    media: { kind: 'merged', durationUs: 5_000_000, hasAudio: false },
    hasPointer: false,
    metadata: {},
  });
  const encoded = encodeManifest(manifest);
  const text = encoded.ok ? encoded.value : '';

  it('migrates a version 1 project: default cursor settings, nothing else changed', () => {
    const read = readManifest(MANIFEST_V1);
    expect(read).toMatchObject({ ok: true, value: { migratedFrom: 1 } });
    if (!read.ok) return;
    const { manifest: migrated } = read.value;
    const original = JSON.parse(MANIFEST_V1) as { project: { settings: object } };
    expect(migrated.manifestVersion).toBe(11);
    expect(migrated.project.settings).toEqual({
      ...original.project.settings,
      cursor: { visible: true, size: 1.5, smoothing: 0.5, clickEffect: 'ripple' },
      autoZoom: { enabled: true, scale: 2, disabled: [] },
      canvas: {
        aspect: 'source',
        background: { kind: 'solid', color: '#0b1020' },
        padding: 0,
        cornerRadius: 0,
        shadow: { opacity: 0, blur: 0.04, offsetY: 0.01 },
      },
    });
    expect(migrated.project.analysisRuns).toEqual([]);
    const { analysisRuns: _runs, ...rest } = migrated.project;
    expect({ ...rest, settings: original.project.settings }).toEqual(original.project);
  });

  it('migrates a version 2 zoom: its pose becomes the first keyframe, at its start', () => {
    const read = readManifest(MANIFEST_V2);
    expect(read).toMatchObject({ ok: true, value: { migratedFrom: 2 } });
    if (!read.ok) return;
    const [zoom, blur] = read.value.manifest.project.timeline.tracks[0]?.clips[0]?.effects ?? [];
    expect(zoom).toMatchObject({
      kind: 'zoom',
      poses: [
        {
          timestampUs: 2_000_000,
          value: { anchor: { x: 0.25, y: 0.75 }, scale: 2 },
          easing: 'ease-in-out',
          // Every keyframe from before version 9 holds, so the camera moves as it did.
          hold: true,
        },
      ],
      easeInUs: 500_000,
    });
    expect(zoom).not.toHaveProperty('pose');
    // Everything else stays as it was.
    const original = JSON.parse(MANIFEST_V2) as {
      project: { timeline: { tracks: { clips: { effects: unknown[] }[] }[] } };
    };
    expect(blur).toEqual(original.project.timeline.tracks[0]?.clips[0]?.effects[1]);
  });

  it('migrates a version 4 project’s clicks: shown ones were ripples', () => {
    const v4 = (shown: boolean) =>
      readManifest(
        text
          .replace('"manifestVersion": 11', '"manifestVersion": 4')
          .replace('"clickEffect": "ripple"', `"clickEffect": ${String(shown)}`),
      );
    expect(v4(true)).toMatchObject({ ok: true, value: { migratedFrom: 4 } });
    const shown = v4(true);
    const hidden = v4(false);
    expect(shown.ok && shown.value.manifest.project.settings.cursor.clickEffect).toBe('ripple');
    expect(hidden.ok && hidden.value.manifest.project.settings.cursor.clickEffect).toBe('none');
  });

  it('reads a current manifest as is', () => {
    expect(readManifest(text)).toEqual(ok({ manifest, migratedFrom: null }));
  });

  it('refuses manifests from a newer build, and damaged ones', () => {
    expect(readManifest(text.replace('"manifestVersion": 11', '"manifestVersion": 12'))).toEqual(
      err({ reason: 'version-newer', version: 12 }),
    );
    expect(readManifest('{"manifestVersion": 1')).toMatchObject({
      ok: false,
      error: { reason: 'invalid' },
    });
    expect(readManifest('[1, 2]')).toMatchObject({ ok: false, error: { reason: 'invalid' } });
    expect(readManifest(text.replace('"title": "Recording"', '"title": ""'))).toMatchObject({
      ok: false,
      error: { reason: 'invalid' },
    });
  });
});
