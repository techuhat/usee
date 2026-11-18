import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, onTestFailed } from 'vitest';

import {
  launchRecorderHost,
  RecorderHostClient,
  RecorderHostConnectionError,
} from '@usee/adapter-recorder-host';
import { hostSegmentSchema, journalRecordSchema, type HostSegment } from '@usee/contracts';
import { decodePointerStream, decodeWaveform } from '@usee/project-format';

import { readMp4 } from './mp4';

const hostPath = path.resolve('native/recorder-host/build/release/recorder-host.exe');

// Runs only where the native host has been built (`npm run build:native`). It
// records the synthetic test pattern, never the real screen.
describe.skipIf(!existsSync(hostPath))('recorder host with the synthetic source', () => {
  let stagingRoot = '';

  beforeEach(async () => {
    stagingRoot = await mkdtemp(path.join(tmpdir(), 'usee-staging-'));
  });

  afterEach(async () => {
    await rm(stagingRoot, { recursive: true, force: true });
  });

  it('records contiguous, hashed, finalized segments and a matching journal', async () => {
    const hostWarnings: unknown[] = [];
    onTestFailed(() => console.error('recorder host warnings:', JSON.stringify(hostWarnings)));
    const host = await launchRecorderHost({
      executablePath: hostPath,
      stagingRoot,
      enableSyntheticSource: true,
      onLog: (record) => {
        if ((record as { level?: string }).level !== 'INFO') hostWarnings.push(record);
      },
    });
    expect(host.hello.protocolMajor).toBe(1);
    expect(host.hello.capabilities.syntheticSource).toBe(true);

    const { displays } = await host.client.request('listDisplays', {});
    expect(displays).toContainEqual(expect.objectContaining({ id: 'synthetic-0', width: 1280 }));

    const events: HostSegment[] = [];
    const states: string[] = [];
    host.client.on('session.segment', (segment) => events.push(segment));
    host.client.on('session.state', (event) => states.push(event.state));

    const started = await host.client.request('startSession', {
      sessionId: 'integration-1',
      displayId: 'synthetic-0',
      frameRateNumerator: 30,
      frameRateDenominator: 1,
      includeCursor: false,
      trackPointer: false,
      segmentDurationMs: 2_000,
      audioInputId: null,
    });
    expect(started.video).toMatchObject({ width: 1280, height: 720 });
    expect(started.audio).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const summary = await host.client.request(
      'stopSession',
      { sessionId: 'integration-1' },
      30_000,
    );
    const exit = await host.shutdown();

    expect(exit.code).toBe(0);
    expect(summary.failure).toBeNull();
    expect(states).toEqual(['recording', 'finalizing', 'completed']);
    expect(summary.segments.length).toBeGreaterThanOrEqual(2);
    expect(events).toHaveLength(summary.segments.length);
    expect(summary.framesEncoded).toBeGreaterThan(120);
    expect(summary.durationUs).toBeGreaterThan(4_000_000);

    const sessionDirectory = path.join(stagingRoot, 'integration-1');
    const video = summary.segments.filter((segment) => segment.stream === 'video');
    for (const [position, segment] of video.entries()) {
      const bytes = await readFile(path.join(sessionDirectory, segment.fileName));
      expect(bytes.length).toBe(segment.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(segment.sha256);

      const mp4 = readMp4(bytes);
      expect(mp4.topLevelBoxes).toEqual(expect.arrayContaining(['ftyp', 'moov', 'mdat']));
      expect(mp4.durationSeconds).toBeCloseTo(segment.durationUs / 1e6, 1);

      // Segments never overlap. They tile the clock exactly unless the encoder
      // fell behind at a boundary, which can only happen with dropped frames.
      const previous = video[position - 1];
      if (previous !== undefined) {
        const previousEnd = previous.startUs + previous.durationUs;
        expect(segment.startUs).toBeGreaterThanOrEqual(previousEnd);
        if (summary.framesDropped === 0) {
          expect(segment.startUs).toBe(previousEnd);
        }
      }
    }

    // Every journal line the C++ host writes must satisfy the TypeScript contract.
    const journal = (await readFile(path.join(sessionDirectory, 'journal.ndjson'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => journalRecordSchema.parse(JSON.parse(line)));
    expect(journal[0]).toMatchObject({
      record: 'session-started',
      displayId: 'synthetic-0',
      pointer: null,
    });
    const finalized = journal.at(-1);
    expect(finalized?.record).toBe('session-finalized');
    // The synthetic pattern is drawn every couple of milliseconds, so its
    // pictures are hardly older than the frame times they are encoded at.
    const latency = finalized?.record === 'session-finalized' ? finalized.captureLatencyUs : -1;
    expect(latency).toBeGreaterThanOrEqual(500);
    expect(latency).toBeLessThan(20_000);
    const closed = journal.filter((entry) => entry.record === 'segment-closed');
    // The journal alone is enough to recover the session: it lists the same segments.
    expect(closed.map((entry) => hostSegmentSchema.parse(entry))).toEqual(summary.segments);
  }, 60_000);

  it('records a window at its own size and journals it by its ID alone', async () => {
    const host = await launchRecorderHost({
      executablePath: hostPath,
      stagingRoot,
      enableSyntheticSource: true,
    });
    // The list also holds this machine's real windows; only the synthetic one is looked at.
    const { windows } = await host.client.request('listWindows', {});
    expect(windows[0]?.id).toBe('window-synthetic');
    expect(windows[0]).toEqual({
      id: 'window-synthetic',
      title: 'Synthetic test window',
      width: 960,
      height: 600,
    });

    const session = {
      frameRateNumerator: 30,
      frameRateDenominator: 1,
      includeCursor: false,
      trackPointer: true,
      segmentDurationMs: 2_000,
      audioInputId: null,
    } as const;
    // A window that is not open (any more) is refused before anything records.
    await expect(
      host.client.request('startSession', {
        ...session,
        sessionId: 'window-gone',
        sourceKind: 'window',
        windowId: 'window-7fffffff00000000',
      }),
    ).rejects.toMatchObject({ hostError: { code: 'capture.source-unavailable' } });

    const started = await host.client.request('startSession', {
      ...session,
      sessionId: 'window-1',
      sourceKind: 'window',
      windowId: 'window-synthetic',
    });
    expect(started.video).toMatchObject({ width: 960, height: 600 });
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const summary = await host.client.request('stopSession', { sessionId: 'window-1' }, 30_000);
    await host.shutdown();
    expect(summary.failure).toBeNull();
    expect(summary.framesEncoded).toBeGreaterThan(30);

    const text = await readFile(path.join(stagingRoot, 'window-1', 'journal.ndjson'), 'utf8');
    const first = journalRecordSchema.parse(JSON.parse(text.split('\n')[0] ?? ''));
    expect(first).toMatchObject({
      record: 'session-started',
      sourceKind: 'window',
      windowId: 'window-synthetic',
      video: { width: 960, height: 600 },
    });
    expect(first).not.toHaveProperty('displayId');
    // Titles are for the picker only (ADR-009).
    expect(text).not.toContain('Synthetic test window');
  }, 60_000);

  it('records a region of a display, cropped to it, and refuses one outside it', async () => {
    const host = await launchRecorderHost({
      executablePath: hostPath,
      stagingRoot,
      enableSyntheticSource: true,
    });
    const session = {
      frameRateNumerator: 30,
      frameRateDenominator: 1,
      includeCursor: false,
      trackPointer: true,
      segmentDurationMs: 2_000,
      audioInputId: null,
      sourceKind: 'region',
      displayId: 'synthetic-0',
    } as const;
    // The synthetic display is 1280 x 720.
    await expect(
      host.client.request('startSession', {
        ...session,
        sessionId: 'region-outside',
        region: { x: 1000, y: 0, width: 640, height: 360 },
      }),
    ).rejects.toMatchObject({ hostError: { code: 'native.invalid-params' } });

    const region = { x: 640, y: 360, width: 640, height: 360 };
    const started = await host.client.request('startSession', {
      ...session,
      sessionId: 'region-1',
      region,
    });
    expect(started.video).toMatchObject({ width: 640, height: 360 });
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const summary = await host.client.request('stopSession', { sessionId: 'region-1' }, 30_000);
    await host.shutdown();
    expect(summary.failure).toBeNull();

    const directory = path.join(stagingRoot, 'region-1');
    const text = await readFile(path.join(directory, 'journal.ndjson'), 'utf8');
    expect(journalRecordSchema.parse(JSON.parse(text.split('\n')[0] ?? ''))).toMatchObject({
      record: 'session-started',
      sourceKind: 'region',
      displayId: 'synthetic-0',
      region,
      video: { width: 640, height: 360 },
    });

    // The pointer is normalized to the region: the synthetic circle, which
    // stays within 0.2-0.8 of the display, passes left of this one.
    const pointer = decodePointerStream(
      await readFile(path.join(directory, 'pointer.ndjson'), 'utf8'),
    );
    if (!pointer.ok) throw new Error('The pointer stream did not decode.');
    expect(pointer.value.stream.display).toEqual({ width: 640, height: 360, dpiScale: 1 });
    const xs = pointer.value.stream.events.flatMap((event) => ('x' in event ? [event.x] : []));
    expect(Math.min(...xs)).toBeLessThan(0);
  }, 60_000);

  it('records the synthetic tone and merges every segment into one recording', async () => {
    const hostWarnings: unknown[] = [];
    onTestFailed(() => console.error('recorder host warnings:', JSON.stringify(hostWarnings)));
    const host = await launchRecorderHost({
      executablePath: hostPath,
      stagingRoot,
      enableSyntheticSource: true,
      onLog: (record) => {
        if ((record as { level?: string }).level !== 'INFO') hostWarnings.push(record);
      },
    });
    const { inputs } = await host.client.request('listAudioInputs', {});
    expect(inputs).toContainEqual(expect.objectContaining({ id: 'synthetic-audio' }));

    const started = await host.client.request('startSession', {
      sessionId: 'merge-1',
      displayId: 'synthetic-0',
      frameRateNumerator: 30,
      frameRateDenominator: 1,
      includeCursor: false,
      trackPointer: true,
      segmentDurationMs: 2_000,
      audioInputId: 'synthetic-audio',
    });
    expect(started.audio).toEqual({ sampleRateHz: 48_000, channels: 2 });
    await expect(
      host.client.request('mergeSession', { sessionId: 'merge-1', verifyHashes: false }),
    ).rejects.toMatchObject({ hostError: { code: 'capture.session-active' } });

    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const summary = await host.client.request('stopSession', { sessionId: 'merge-1' }, 30_000);
    expect(summary.failure).toBeNull();

    // One AAC stream for the whole session: audio segments start at zero and
    // tile it exactly, in whole 1024-sample frames.
    const end = (segment: HostSegment) => segment.startUs + segment.durationUs;
    const audio = summary.segments.filter((segment) => segment.stream === 'audio');
    const video = summary.segments.filter((segment) => segment.stream === 'video');
    expect(audio.length).toBeGreaterThanOrEqual(2);
    expect(audio[0]?.startUs).toBe(0);
    for (const [position, segment] of audio.entries()) {
      expect(segment.frames % 1024).toBe(0);
      const previous = audio[position - 1];
      if (previous !== undefined) {
        expect(segment.startUs).toBe(end(previous));
      }
    }
    const videoEndUs = Math.max(...video.map(end));
    expect(Math.abs(Math.max(...audio.map(end)) - videoEndUs)).toBeLessThan(150_000);

    const merged = await host.client.request(
      'mergeSession',
      { sessionId: 'merge-1', verifyHashes: true },
      60_000,
    );
    expect(merged).toMatchObject({
      fileName: 'recording.mp4',
      durationUs: videoEndUs,
      hasAudio: true,
      segmentsMerged: summary.segments.length,
      segmentsSkipped: 0,
    });

    const directory = path.join(stagingRoot, 'merge-1');
    const bytes = await readFile(path.join(directory, 'recording.mp4'));
    expect(bytes.length).toBe(merged.bytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(merged.sha256);
    const mp4 = readMp4(bytes);
    expect(mp4.tracks.map((track) => track.handler).sort()).toEqual(['soun', 'vide']);
    for (const track of mp4.tracks) {
      expect(Math.abs((track.durationSeconds ?? 0) - videoEndUs / 1e6)).toBeLessThan(0.15);
    }

    // The tone sounds for half of every second, so about half the peaks are loud.
    expect(merged.waveform).toMatchObject({ fileName: 'waveform.json', peaksPerSecond: 100 });
    const waveform = decodeWaveform(await readFile(path.join(directory, 'waveform.json'), 'utf8'));
    expect(waveform.ok).toBe(true);
    if (!waveform.ok) return;
    expect(waveform.value).toMatchObject({
      inputSha256: merged.sha256,
      peakCount: merged.waveform?.peakCount,
    });
    expect(Math.abs(waveform.value.peakCount - videoEndUs / 10_000)).toBeLessThan(20);
    const peaks = Buffer.from(waveform.value.peaks, 'base64');
    const loudShare = peaks.filter((peak) => peak > 32).length / peaks.length;
    expect(loudShare).toBeGreaterThan(0.35);
    expect(loudShare).toBeLessThan(0.65);

    // The synthetic pointer circles the frame and clicks once a second; never keystrokes.
    const pointer = decodePointerStream(
      await readFile(path.join(directory, 'pointer.ndjson'), 'utf8'),
    );
    expect(pointer.ok).toBe(true);
    if (!pointer.ok) return;
    const { stream, skippedLines } = pointer.value;
    expect(skippedLines).toBe(0);
    expect(stream.display).toEqual({ width: 1280, height: 720, dpiScale: 1 });
    const count = (type: string) => stream.events.filter((event) => event.type === type).length;
    expect(count('move')).toBeGreaterThan(400);
    expect(count('down')).toBeGreaterThanOrEqual(4);
    expect(count('up')).toBe(count('down'));
    expect(
      stream.events.filter((event) => event.type === 'shape').map((event) => event.shape),
    ).toEqual(expect.arrayContaining(['arrow', 'pointer']));
    for (const event of stream.events) {
      expect(event.timeUs).toBeLessThanOrEqual(summary.durationUs + 100_000);
      if (event.type === 'move') {
        expect(Math.hypot(event.x - 0.5, event.y - 0.5)).toBeCloseTo(0.3, 2);
      }
    }

    await expect(
      host.client.request('mergeSession', { sessionId: 'never-recorded', verifyHashes: false }),
    ).rejects.toMatchObject({ hostError: { code: 'storage.session-not-found' } });
    expect((await host.shutdown()).code).toBe(0);
  }, 90_000);

  it('rejects a client with the wrong token and closes the pipe', async () => {
    const { client, child } = await spawnUnauthenticated(stagingRoot);
    await expect(
      client.request('hello', { protocolMajor: 1, protocolMinor: 0, token: '0'.repeat(64) }),
    ).rejects.toMatchObject({
      name: 'RecorderHostRequestError',
      hostError: { code: 'native.unauthorized' },
    });
    await client.closed;
    child.kill();
  }, 30_000);

  it('closes the connection when the first request is not hello', async () => {
    const { client, child } = await spawnUnauthenticated(stagingRoot);
    await expect(client.request('listDisplays', {})).rejects.toBeInstanceOf(
      RecorderHostConnectionError,
    );
    child.kill();
  }, 30_000);
});

async function spawnUnauthenticated(stagingRoot: string) {
  const pipeName = `\\\\.\\pipe\\usee-recorder-${randomBytes(16).toString('hex')}`;
  const child = spawn(hostPath, [], {
    env: {
      SystemRoot: process.env['SystemRoot'] ?? 'C:\\Windows',
      USEE_PIPE_NAME: pipeName,
      USEE_HOST_TOKEN: randomBytes(32).toString('hex'),
      USEE_STAGING_ROOT: stagingRoot,
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  const client = await RecorderHostClient.connect(pipeName, 10_000);
  return { client, child };
}
