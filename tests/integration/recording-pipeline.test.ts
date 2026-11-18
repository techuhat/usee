import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, onTestFailed } from 'vitest';

import { createRecordingStore } from '@usee/adapter-project-fs';
import { createRecorderHostSupervisor } from '@usee/adapter-recorder-host';
import { RecordingService } from '@usee/application';
import { asCorrelationId, asProjectId, asRecordingSessionId } from '@usee/contracts';
import {
  decodeManifest,
  decodePointerStream,
  decodeWaveform,
  waveformPath,
} from '@usee/project-format';

import { readMp4 } from './mp4';

const hostPath = path.resolve('native/recorder-host/build/release/recorder-host.exe');

describe.skipIf(!existsSync(hostPath))('recording pipeline end to end', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'usee-pipeline-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('records the synthetic sources and imports one playable recording', async () => {
    const stagingRoot = path.join(root, 'staging');
    const projectsRoot = path.join(root, 'projects');
    await mkdir(stagingRoot);
    const correlationId = () => asCorrelationId(randomUUID());
    // The host's own warnings explain most failures; print them if this test fails.
    const hostWarnings: unknown[] = [];
    onTestFailed(() => console.error('recorder host warnings:', JSON.stringify(hostWarnings)));

    const host = createRecorderHostSupervisor({
      executablePath: hostPath,
      stagingRoot,
      enableSyntheticSource: true,
      onLog: (record) => {
        if ((record as { level?: string }).level !== 'INFO') hostWarnings.push(record);
      },
      createCorrelationId: correlationId,
    });
    const service = new RecordingService({
      host,
      store: createRecordingStore({
        stagingRoot,
        projectsRoot,
        now: () => new Date(),
        createProjectId: () => asProjectId(randomUUID()),
        createCorrelationId: correlationId,
      }),
      createSessionId: () => asRecordingSessionId(randomUUID()),
      createCorrelationId: correlationId,
      now: () => new Date(),
      segmentDurationMs: 2_000,
    });

    try {
      const sources = await service.listSources();
      expect(sources.ok && sources.value.displays.map((display) => display.id)).toContain(
        'synthetic-0',
      );

      const started = await service.start({
        source: { kind: 'display', displayId: 'synthetic-0' },
        audioInputId: 'synthetic-audio',
        frameRate: 30,
        includeCursor: false,
        trackPointer: true,
      });
      if (!started.ok) {
        throw new Error(`start failed: ${JSON.stringify(started.error)}`);
      }
      expect(started.value).toMatchObject({ phase: 'recording', microphone: 'on' });

      await new Promise((resolve) => setTimeout(resolve, 4_500));
      const stopped = await service.stop();
      expect(stopped).toMatchObject({ ok: true, value: { phase: 'completed' } });
      if (!stopped.ok || stopped.value.phase !== 'completed') return;

      const bundle = stopped.value.projectPath;
      const manifest = decodeManifest(await readFile(path.join(bundle, 'manifest.json'), 'utf8'));
      expect(manifest.ok).toBe(true);
      if (!manifest.ok) return;

      // The segments were merged: one asset holding video and audio, one clip spanning it,
      // and the pointer stream kept beside it as the session's event asset.
      const { assets, timeline, recordingSessions } = manifest.value.project;
      expect(assets).toEqual([
        expect.objectContaining({ kind: 'video', hasAudio: true }),
        expect.objectContaining({ kind: 'event', eventEncoding: 'jsonl' }),
      ]);
      const pointerAsset = assets[1];
      expect(recordingSessions[0]?.interactionAssetId).toBe(pointerAsset?.id);
      const pointer = decodePointerStream(
        await readFile(path.join(bundle, ...(pointerAsset?.relativePath ?? '').split('/')), 'utf8'),
      );
      expect(pointer.ok && pointer.value.stream.events.length).toBeGreaterThan(100);
      const asset = assets[0];
      if (asset === undefined) return;
      expect(timeline.tracks).toHaveLength(1);
      expect(timeline.tracks[0]?.clips).toEqual([
        expect.objectContaining({
          assetId: asset.id,
          sourceRange: { startUs: 0, durationUs: asset.durationUs },
        }),
      ]);
      const media = await readFile(path.join(bundle, ...asset.relativePath.split('/')));
      const mp4 = readMp4(media);
      expect(mp4.tracks.map((track) => track.handler).sort()).toEqual(['soun', 'vide']);
      expect(mp4.durationSeconds).toBeGreaterThan(4);

      const waveform = decodeWaveform(
        await readFile(path.join(bundle, ...waveformPath(asset.id).split('/')), 'utf8'),
      );
      expect(waveform.ok && waveform.value.inputSha256).toBe(
        createHash('sha256').update(media).digest('hex'),
      );
      await expect(readdir(stagingRoot)).resolves.toEqual([]);
      await expect(service.listInterrupted()).resolves.toEqual({ ok: true, value: [] });
    } finally {
      await host.dispose();
    }
  }, 60_000);
});
