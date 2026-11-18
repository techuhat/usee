import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  asCorrelationId,
  asAssetId,
  asEffectId,
  asProjectId,
  asRecordingSessionId,
  asTimestampUs,
  asDurationUs,
} from '@usee/contracts';
import type { Project } from '@usee/domain';
import {
  createRecordingProject,
  decodeManifest,
  encodeManifest,
  type ProjectManifest,
} from '@usee/project-format';

import { createProjectRepository, persistMigration } from './project-repository';

let projectsRoot = '';

beforeEach(async () => {
  // Canonical, as the repository resolves every path: the temporary folder may be named
  // by an 8.3 short name, as on GitHub's Windows runner (C:\Users\RUNNER~1\...).
  projectsRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'project-repository-')));
});

afterEach(async () => {
  await rm(projectsRoot, { recursive: true, force: true });
});

function manifestFor(title: string, hasPointer = false): ProjectManifest {
  return createRecordingProject({
    projectId: asProjectId('project-1'),
    title,
    createdAtUs: 1_792_000_000_000_000,
    sessionId: asRecordingSessionId('session-1'),
    source: { kind: 'display', displayId: 'display-0a1b2c3d' },
    video: { width: 1920, height: 1080 },
    frameRate: { numerator: 60, denominator: 1 },
    audio: null,
    media: { kind: 'merged', durationUs: 8_000_000, hasAudio: true },
    hasPointer,
    metadata: { encoderName: 'GPU H.264' },
  });
}

async function writeBundle(name: string, manifest: ProjectManifest | string): Promise<string> {
  const projectPath = path.join(projectsRoot, `${name}.screenproj`);
  await mkdir(projectPath, { recursive: true });
  const encoded = typeof manifest === 'string' ? manifest : encodeManifest(manifest);
  const text = typeof encoded === 'string' ? encoded : encoded.ok ? encoded.value : '';
  await writeFile(path.join(projectPath, 'manifest.json'), text);
  return projectPath;
}

const repository = () =>
  createProjectRepository({ projectsRoot, createCorrelationId: () => asCorrelationId('corr') });

/** The project with its only clip cut to its first two seconds. */
function trimmed(project: Project): Project {
  const [track] = project.timeline.tracks;
  const [clip] = track?.clips ?? [];
  if (track === undefined || clip === undefined) throw new Error('fixture has no clip');
  return {
    ...project,
    title: 'Edited',
    timeline: {
      ...project.timeline,
      tracks: [
        {
          ...track,
          clips: [{ ...clip, sourceRange: { ...clip.sourceRange, durationUs: asDurationUs(2e6) } }],
        },
      ],
    },
  };
}

describe('project repository', () => {
  it('opens a current project as it is', async () => {
    const manifest = manifestFor('Recording');
    const projectPath = await writeBundle('Recording', manifest);
    await expect(repository().open(projectPath)).resolves.toEqual({
      ok: true,
      value: { project: manifest.project, migratedFrom: null },
    });
  });

  it('resolves only existing managed media files for a project ID', async () => {
    const manifest = manifestFor('Recording');
    const projectPath = await writeBundle('Recording', manifest);
    const video = manifest.project.assets.find((asset) => asset.kind === 'video');
    if (video === undefined) throw new Error('Fixture has no video asset.');
    const mediaPath = path.join(projectPath, ...video.relativePath.split('/'));
    await mkdir(path.dirname(mediaPath), { recursive: true });
    await writeFile(mediaPath, 'synthetic video bytes');

    const resolved = await repository().resolveMediaAssets(manifest.project.id, [video.id]);
    expect(resolved).toEqual({ ok: true, value: { [video.id]: mediaPath } });
    await expect(
      repository().resolveMediaAssets(manifest.project.id, [asAssetId('missing-asset')]),
    ).resolves.toMatchObject({ ok: false, error: { code: 'project.asset-not-found' } });
  });

  it('saves atomically, keeps the previous manifest as the checkpoint and its metadata', async () => {
    const manifest = manifestFor('Recording');
    const projectPath = await writeBundle('Recording', manifest);
    const before = await readFile(path.join(projectPath, 'manifest.json'), 'utf8');

    const edited = trimmed(manifest.project);
    await expect(repository().save(projectPath, edited)).resolves.toEqual({
      ok: true,
      value: undefined,
    });

    const saved = decodeManifest(await readFile(path.join(projectPath, 'manifest.json'), 'utf8'));
    expect(saved).toEqual({ ok: true, value: { ...manifest, project: edited } });
    await expect(
      readFile(path.join(projectPath, 'recovery', 'checkpoints', 'manifest.json'), 'utf8'),
    ).resolves.toBe(before);
    await expect(repository().open(projectPath)).resolves.toMatchObject({
      ok: true,
      value: { project: { title: 'Edited' } },
    });
  });

  it('never writes a manifest it could not open again', async () => {
    const manifest = manifestFor('Recording');
    const projectPath = await writeBundle('Recording', manifest);
    const before = await readFile(path.join(projectPath, 'manifest.json'), 'utf8');
    const [track] = manifest.project.timeline.tracks;
    const [clip] = track?.clips ?? [];
    if (track === undefined || clip === undefined) return;
    const withEffect: Project = {
      ...manifest.project,
      timeline: {
        ...manifest.project.timeline,
        tracks: [
          {
            ...track,
            clips: [
              {
                ...clip,
                effects: [
                  {
                    id: asEffectId('effect-1'),
                    kind: 'zoom',
                    range: { startUs: asTimestampUs(0), durationUs: asDurationUs(1_000_000) },
                    enabled: true,
                    // The manifest schema caps zoom at 8x.
                    poses: [
                      {
                        timestampUs: asTimestampUs(0),
                        value: { anchor: { x: 0.5, y: 0.5 }, scale: 20 },
                        easing: 'linear',
                      },
                    ],
                    easeInUs: 0,
                    easeOutUs: 0,
                    easing: 'linear',
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    await expect(repository().save(projectPath, withEffect)).resolves.toMatchObject({
      ok: false,
      error: { code: 'project.invalid' },
    });
    await expect(readFile(path.join(projectPath, 'manifest.json'), 'utf8')).resolves.toBe(before);
  });

  it('refuses a project from a newer build, a damaged one and a missing one', async () => {
    const text = JSON.stringify({ ...manifestFor('New'), manifestVersion: 12 });
    const newer = await writeBundle('Newer', text);
    const damaged = await writeBundle('Damaged', '{"manifestVersion": 1, "proj');

    await expect(repository().open(newer)).resolves.toMatchObject({
      ok: false,
      error: { category: 'project', code: 'project.version-newer' },
    });
    await expect(repository().open(damaged)).resolves.toMatchObject({
      ok: false,
      error: { code: 'project.manifest-invalid' },
    });
    await expect(
      repository().open(path.join(projectsRoot, 'Missing.screenproj')),
    ).resolves.toMatchObject({ ok: false, error: { code: 'project.not-found' } });
  });

  it('opens only bundles directly inside the projects folder', async () => {
    const projectPath = await writeBundle('Recording', manifestFor('Recording'));
    const nested = path.join(projectsRoot, 'folder', 'Nested.screenproj');
    await mkdir(nested, { recursive: true });
    await writeFile(
      path.join(nested, 'manifest.json'),
      await readFile(path.join(projectPath, 'manifest.json')),
    );
    const plainFolder = path.join(projectsRoot, 'Plain');
    await mkdir(plainFolder);

    for (const candidate of [nested, plainFolder, projectsRoot, 'Recording.screenproj']) {
      await expect(repository().open(candidate)).resolves.toMatchObject({
        ok: false,
        error: { code: 'project.outside-projects-folder' },
      });
    }
    await expect(
      repository().save(nested, manifestFor('Recording').project),
    ).resolves.toMatchObject({ ok: false, error: { code: 'project.outside-projects-folder' } });
    await expect(repository().open(`${projectPath}${path.sep}`)).resolves.toMatchObject({
      ok: true,
    });
  });

  it('migrates a version 1 project on open, keeping the original as a backup', async () => {
    const current = manifestFor('Recording');
    const { cursor: _cursor, ...v1Settings } = current.project.settings;
    const v1 = JSON.stringify({
      ...current,
      manifestVersion: 1,
      project: { ...current.project, settings: v1Settings },
    });
    const projectPath = await writeBundle('Recording', v1);

    const opened = await repository().open(projectPath);
    expect(opened).toMatchObject({ ok: true, value: { migratedFrom: 1 } });
    await expect(
      readFile(path.join(projectPath, 'recovery', 'checkpoints', 'manifest-v1.json'), 'utf8'),
    ).resolves.toBe(v1);
    const onDisk = decodeManifest(await readFile(path.join(projectPath, 'manifest.json'), 'utf8'));
    expect(onDisk).toEqual({ ok: true, value: current });
    // Opening again finds a current manifest: nothing more to migrate.
    await expect(repository().open(projectPath)).resolves.toMatchObject({
      ok: true,
      value: { migratedFrom: null },
    });
  });

  it('keeps the pre-migration manifest before writing the migrated one', async () => {
    const manifest = manifestFor('Recording');
    const projectPath = await writeBundle('Recording', '{"manifestVersion": 0, "old": true}');
    await persistMigration(projectPath, '{"manifestVersion": 0, "old": true}', manifest, 0);

    await expect(
      readFile(path.join(projectPath, 'recovery', 'checkpoints', 'manifest-v0.json'), 'utf8'),
    ).resolves.toBe('{"manifestVersion": 0, "old": true}');
    expect(decodeManifest(await readFile(path.join(projectPath, 'manifest.json'), 'utf8'))).toEqual(
      { ok: true, value: manifest },
    );
  });

  it('lists bundles newest first and skips folders without a manifest', async () => {
    const older = await writeBundle('Older', manifestFor('Older recording'));
    await writeBundle('Newer', manifestFor('Newer recording'));
    await writeBundle('Unreadable', 'not json');
    await mkdir(path.join(projectsRoot, 'Importing.screenproj'));
    await mkdir(path.join(projectsRoot, 'Not a bundle'));
    const past = new Date('2026-01-01T00:00:00Z');
    await utimes(path.join(older, 'manifest.json'), past, past);

    const listed = await repository().list();
    expect(listed.ok && listed.value.map((project) => project.title)).toEqual([
      expect.stringMatching(/^(Newer recording|Unreadable)$/),
      expect.stringMatching(/^(Newer recording|Unreadable)$/),
      'Older recording',
    ]);
    expect(listed.ok && listed.value.at(-1)).toEqual({
      projectPath: older,
      title: 'Older recording',
      modifiedAt: past.toISOString(),
    });
  });

  it('keeps a project’s thumbnail, lists it inline, and refuses what is not a small JPEG', async () => {
    const projectPath = await writeBundle('Pictured', manifestFor('Pictured recording'));
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
    expect((await repository().writeThumbnail(projectPath, jpeg)).ok).toBe(true);
    const listed = await repository().list();
    expect(listed.ok && listed.value[0]?.thumbnail).toBe(
      `data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}`,
    );
    // A PNG, or a JPEG too large for a list, is not a thumbnail.
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    expect((await repository().writeThumbnail(projectPath, png)).ok).toBe(false);
    const large = new Uint8Array(200_000);
    large.set([0xff, 0xd8, 0xff]);
    expect((await repository().writeThumbnail(projectPath, large)).ok).toBe(false);
    // Only bundles inside the projects folder.
    const outside = path.join(path.dirname(projectsRoot), 'Elsewhere.screenproj');
    expect((await repository().writeThumbnail(outside, jpeg)).ok).toBe(false);
  });

  it('reads a valid waveform and treats a missing or damaged one as none', async () => {
    const projectPath = await writeBundle('Recording', manifestFor('Recording'));
    const waveforms = path.join(projectPath, 'derived', 'waveforms');
    await mkdir(waveforms, { recursive: true });
    await writeFile(
      path.join(waveforms, 'good.json'),
      JSON.stringify({
        format: 'usee.waveform',
        version: 1,
        producer: 'recorder-host 0.2.0',
        algorithm: 'peak-abs-u8',
        inputSha256: 'a'.repeat(64),
        sampleRateHz: 48_000,
        peaksPerSecond: 100,
        peakCount: 3,
        generatedAt: '2026-10-17T12:00:00.000Z',
        peaks: Buffer.from([0, 128, 255]).toString('base64'),
      }),
    );
    await writeFile(path.join(waveforms, 'damaged.json'), '{"format": "usee.wave');

    await expect(repository().readWaveform(projectPath, 'good')).resolves.toEqual({
      ok: true,
      value: { peaksPerSecond: 100, peaks: 'AID/' },
    });
    for (const assetId of ['damaged', 'missing', '../manifest']) {
      await expect(repository().readWaveform(projectPath, assetId)).resolves.toEqual({
        ok: true,
        value: null,
      });
    }
  });

  it('reads a pointer stream into columns, and treats a missing one as none', async () => {
    const manifest = manifestFor('Recording', true);
    const projectPath = await writeBundle('Recording', manifest);
    const interactions = path.join(projectPath, 'metadata', 'interactions');
    await mkdir(interactions, { recursive: true });
    await writeFile(
      path.join(interactions, 'session-1.pointer.ndjson'),
      [
        '{"format":"usee.pointer","version":1,"sessionId":"session-1","coordinateSpace":"capture","display":{"width":1920,"height":1080,"dpiScale":1.25}}',
        '{"t":0,"type":"shape","shape":"text"}',
        '{"t":1000,"type":"move","x":0.25000,"y":0.50000}',
        '{"t":2000,"type":"down","button":"left","x":0.25000,"y":0.50000}',
        '{"t":3000,"type":"move","x":0.75000,"y":0.12500}',
        '',
      ].join('\n'),
    );

    const read = await repository().readPointerTrack(
      projectPath,
      'metadata/interactions/session-1.pointer.ndjson',
    );
    expect(read.ok).toBe(true);
    if (!read.ok || read.value === null) return;
    const track = read.value;
    expect(track.display).toEqual({ width: 1920, height: 1080, dpiScale: 1.25 });
    // Copied out of Node's pooled buffer first, so the typed array starts aligned.
    const times = new Float64Array(new Uint8Array(Buffer.from(track.moveTimes, 'base64')).buffer);
    expect([...times]).toEqual([1000, 3000]);
    const xs = new Float32Array(new Uint8Array(Buffer.from(track.moveXs, 'base64')).buffer);
    expect([...xs]).toEqual([0.25, 0.75]);
    expect(track.clicks).toEqual([{ timeUs: 2000, x: 0.25, y: 0.5, button: 'left' }]);
    expect(track.shapes).toEqual([{ timeUs: 0, shape: 'text' }]);
    await expect(
      repository().readPointerTrackById(manifest.project.id, asAssetId('session-1-pointer')),
    ).resolves.toMatchObject({ ok: true, value: { clicks: track.clicks } });

    for (const missing of ['metadata/interactions/other.ndjson', '../outside.ndjson']) {
      await expect(repository().readPointerTrack(projectPath, missing)).resolves.toEqual({
        ok: true,
        value: null,
      });
    }

    // For analysis: the decoded stream, and the SHA-256 of the file's bytes.
    const relativePath = 'metadata/interactions/session-1.pointer.ndjson';
    const stream = await repository().readPointerStream(projectPath, relativePath);
    expect(stream.ok).toBe(true);
    if (!stream.ok || stream.value === null) return;
    const bytes = await readFile(path.join(projectPath, relativePath));
    expect(stream.value.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(stream.value.stream.events).toContainEqual({
      type: 'down',
      timeUs: 2000,
      x: 0.25,
      y: 0.5,
      button: 'left',
    });
    await expect(repository().readPointerStream(projectPath, '../outside.ndjson')).resolves.toEqual(
      { ok: true, value: null },
    );
  });

  it('lists nothing before the first recording', async () => {
    const empty = createProjectRepository({
      projectsRoot: path.join(projectsRoot, 'never-created'),
      createCorrelationId: () => asCorrelationId('corr'),
    });
    await expect(empty.list()).resolves.toEqual({ ok: true, value: [] });
  });
});
