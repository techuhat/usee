import { describe, expect, it, vi } from 'vitest';

import {
  asCorrelationId,
  asRecordingSessionId,
  createAppError,
  err,
  ok,
  type AppError,
  type ErrorCategory,
  type HostMergedRecording,
  type HostSessionSummary,
  type RecordingState,
} from '@usee/contracts';

import type { RecorderHostEvent, RecorderHostPort } from './recorder-host-port';
import { RecordingService } from './recording-service';
import type { RecordingStorePort } from './recording-store-port';

const SESSION = 'session-1';

const summary: HostSessionSummary = {
  sessionId: SESSION,
  durationUs: 12_000_000,
  framesCaptured: 700,
  framesEncoded: 720,
  framesDropped: 2,
  audioDiscontinuities: 0,
  audioFailed: false,
  segments: [],
  failure: null,
};

const merged: HostMergedRecording = {
  sessionId: SESSION,
  fileName: 'recording.mp4',
  durationUs: 12_000_000,
  bytes: 1_000,
  sha256: 'b'.repeat(64),
  videoFrames: 720,
  hasAudio: true,
  segmentsMerged: 4,
  segmentsSkipped: 0,
  waveform: { fileName: 'waveform.json', peaksPerSecond: 100, peakCount: 1_200 },
};

const imported = { projectPath: 'C:/Videos/Recording.screenproj', durationUs: 12_000_000 };

function appError(code: `${ErrorCategory}.${string}`): AppError {
  return createAppError({
    category: code.slice(0, code.indexOf('.')) as ErrorCategory,
    code,
    retryable: true,
    userMessageKey: `errors.${code}`,
    correlationId: asCorrelationId('corr'),
  });
}

function setup() {
  let emit: (event: RecorderHostEvent) => void = () => undefined;
  const host = {
    listDisplays: vi.fn<RecorderHostPort['listDisplays']>(() => Promise.resolve(ok([]))),
    listWindows: vi.fn<RecorderHostPort['listWindows']>(() => Promise.resolve(ok([]))),
    listAudioInputs: vi.fn<RecorderHostPort['listAudioInputs']>(() => Promise.resolve(ok([]))),
    startSession: vi.fn<RecorderHostPort['startSession']>(() =>
      Promise.resolve(
        ok({
          sessionId: SESSION,
          video: { width: 1920, height: 1080, encoderName: 'GPU', hardwareEncoder: true },
          audio: { sampleRateHz: 48_000, channels: 2 },
        }),
      ),
    ),
    stopSession: vi.fn<RecorderHostPort['stopSession']>(() => Promise.resolve(ok(summary))),
    mergeSession: vi.fn<RecorderHostPort['mergeSession']>(() => Promise.resolve(ok(merged))),
    subscribe: vi.fn((listener: (event: RecorderHostEvent) => void) => {
      emit = listener;
      return () => undefined;
    }),
  } satisfies RecorderHostPort;
  const store = {
    importMergedSession: vi.fn<RecordingStorePort['importMergedSession']>(() =>
      Promise.resolve(ok(imported)),
    ),
    importSession: vi.fn<RecordingStorePort['importSession']>(() => Promise.resolve(ok(imported))),
    listInterrupted: vi.fn<RecordingStorePort['listInterrupted']>(() => Promise.resolve(ok([]))),
    recoverSession: vi.fn<RecordingStorePort['recoverSession']>(),
    discardSession: vi.fn<RecordingStorePort['discardSession']>(),
  } satisfies RecordingStorePort;

  const service = new RecordingService({
    host,
    store,
    createSessionId: () => asRecordingSessionId(SESSION),
    createCorrelationId: () => asCorrelationId('corr'),
    now: () => new Date('2026-10-17T10:00:00.000Z'),
    segmentDurationMs: 4_000,
  });
  const states: RecordingState['phase'][] = [];
  service.subscribe((state) => states.push(state.phase));
  return { service, host, store, states, emit: (event: RecorderHostEvent) => emit(event) };
}

const request = {
  source: { kind: 'display', displayId: 'display-1' },
  audioInputId: 'audio-1',
  frameRate: 60,
  includeCursor: true,
  trackPointer: false,
} as const;

describe('RecordingService', () => {
  it('starts a session through the host and reports the recording state', async () => {
    const { service, host, states } = setup();
    const result = await service.start(request);

    expect(host.startSession).toHaveBeenCalledWith({
      sessionId: SESSION,
      displayId: 'display-1',
      frameRateNumerator: 60,
      frameRateDenominator: 1,
      includeCursor: true,
      trackPointer: false,
      segmentDurationMs: 4_000,
      audioInputId: 'audio-1',
    });
    expect(result).toEqual(
      ok({
        phase: 'recording',
        sessionId: SESSION,
        startedAt: '2026-10-17T10:00:00.000Z',
        metrics: { elapsedUs: 0, framesEncoded: 0, framesDropped: 0 },
        microphone: 'on',
        hardwareEncoder: true,
      }),
    );
    expect(states).toEqual(['preparing', 'recording']);
  });

  it('records one window by its ID', async () => {
    const { service, host } = setup();
    await service.start({
      ...request,
      source: { kind: 'window', windowId: 'window-00000000000a0b0c' },
    });

    expect(host.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKind: 'window', windowId: 'window-00000000000a0b0c' }),
    );
    expect(host.startSession.mock.calls[0]?.[0]).not.toHaveProperty('displayId');
  });

  it('records a region of a display', async () => {
    const { service, host } = setup();
    const region = { x: 100, y: 50, width: 640, height: 360 };
    await service.start({ ...request, source: { kind: 'region', displayId: 'display-1', region } });

    expect(host.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKind: 'region', displayId: 'display-1', region }),
    );
  });

  it('lists the displays, the open windows and the microphones', async () => {
    const { service, host } = setup();
    const window = { id: 'window-00000000000a0b0c', title: 'Notes', width: 800, height: 600 };
    host.listWindows.mockResolvedValue(ok([window]));

    await expect(service.listSources()).resolves.toEqual(
      ok({ displays: [], windows: [window], audioInputs: [] }),
    );
  });

  it('records the pointer instead of drawing the OS cursor into the video', async () => {
    const { service, host } = setup();
    await service.start({ ...request, trackPointer: true });
    expect(host.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ includeCursor: false, trackPointer: true }),
    );
  });

  it('refuses a second start while a session is active', async () => {
    const { service } = setup();
    await service.start(request);
    const second = await service.start(request);
    expect(second).toMatchObject({ ok: false, error: { code: 'capture.session-active' } });
  });

  it('reports a failed start and allows another attempt', async () => {
    const { service, host } = setup();
    host.startSession.mockResolvedValueOnce(err(appError('capture.source-unavailable')));
    const failed = await service.start(request);
    expect(failed).toMatchObject({ ok: false, error: { code: 'capture.source-unavailable' } });
    expect(service.state).toMatchObject({ phase: 'failed', projectPath: null });

    await expect(service.start(request)).resolves.toMatchObject({ ok: true });
  });

  it('stops, merges, imports and completes; a second stop joins the first', async () => {
    const { service, host, store, states } = setup();
    await service.start(request);
    const [first, second] = await Promise.all([service.stop(), service.stop()]);

    expect(host.stopSession).toHaveBeenCalledOnce();
    expect(host.mergeSession).toHaveBeenCalledWith(SESSION, { verifyHashes: false });
    expect(store.importMergedSession).toHaveBeenCalledWith(SESSION, merged);
    expect(store.importSession).not.toHaveBeenCalled();
    expect(first).toEqual(second);
    expect(first).toEqual(
      ok({
        phase: 'completed',
        sessionId: SESSION,
        projectPath: 'C:/Videos/Recording.screenproj',
        durationUs: 12_000_000,
        framesDropped: 2,
      }),
    );
    expect(states).toEqual(['preparing', 'recording', 'finalizing', 'completed']);
  });

  it('imports one clip per segment when the merge fails', async () => {
    const { service, host, store } = setup();
    host.mergeSession.mockResolvedValueOnce(err(appError('encoding.merge-incompatible')));
    await service.start(request);
    const stopped = await service.stop();

    expect(store.importMergedSession).not.toHaveBeenCalled();
    expect(store.importSession).toHaveBeenCalledWith(SESSION, summary);
    expect(stopped).toMatchObject({ ok: true, value: { phase: 'completed' } });
  });

  it('completes when the host is lost while it merges', async () => {
    const { service, host, store, emit } = setup();
    host.mergeSession.mockImplementationOnce(() => {
      emit({ type: 'host-lost', error: appError('native.host-crashed') });
      return Promise.resolve(err(appError('native.host-unavailable')));
    });
    await service.start(request);
    const stopped = await service.stop();

    expect(store.importSession).toHaveBeenCalledOnce();
    expect(stopped).toMatchObject({ ok: true, value: { phase: 'completed' } });
  });

  it('recovers through a hash-checked merge, or segment by segment', async () => {
    const { service, host, store } = setup();
    await expect(service.recover('old-session')).resolves.toEqual(
      ok({ sessionId: 'old-session', ...imported }),
    );
    expect(host.mergeSession).toHaveBeenCalledWith('old-session', { verifyHashes: true });

    host.mergeSession.mockResolvedValueOnce(err(appError('encoding.merge-gap')));
    store.recoverSession.mockResolvedValueOnce(ok({ sessionId: 'old-session', ...imported }));
    await expect(service.recover('old-session')).resolves.toMatchObject({ ok: true });
    expect(store.recoverSession).toHaveBeenCalledWith('old-session');
  });

  it('refuses to stop when nothing is recording', async () => {
    const { service } = setup();
    await expect(service.stop()).resolves.toMatchObject({
      ok: false,
      error: { code: 'capture.session-not-active' },
    });
  });

  it('applies metrics and microphone failures to the recording state', async () => {
    const { service, emit } = setup();
    await service.start(request);

    emit({
      type: 'metrics',
      sessionId: SESSION,
      metrics: { elapsedUs: 5, framesEncoded: 3, framesDropped: 1 },
    });
    expect(service.state).toMatchObject({ metrics: { framesEncoded: 3, framesDropped: 1 } });

    emit({
      type: 'stream-failed',
      sessionId: SESSION,
      stream: 'audio',
      error: appError('capture.device-lost'),
    });
    expect(service.state).toMatchObject({ phase: 'recording', microphone: 'failed' });

    emit({
      type: 'metrics',
      sessionId: 'other-session',
      metrics: { elapsedUs: 9, framesEncoded: 9, framesDropped: 9 },
    });
    expect(service.state).toMatchObject({ metrics: { framesEncoded: 3 } });
  });

  it('saves what was recorded when the host reports a failure mid-session', async () => {
    const { service, store, emit } = setup();
    await service.start(request);
    emit({ type: 'session-failed', sessionId: SESSION, error: appError('capture.source-closed') });
    await vi.waitFor(() => expect(service.state.phase).toBe('failed'));

    expect(store.importMergedSession).toHaveBeenCalledOnce();
    expect(service.state).toMatchObject({
      phase: 'failed',
      error: { code: 'capture.source-closed' },
      projectPath: 'C:/Videos/Recording.screenproj',
    });
  });

  it('leaves segments staged for recovery when the host crashes', async () => {
    const { service, host, store, emit } = setup();
    await service.start(request);
    emit({ type: 'host-lost', error: appError('capture.host-crashed') });

    expect(service.state).toMatchObject({ phase: 'failed', projectPath: null });
    expect(host.mergeSession).not.toHaveBeenCalled();
    expect(store.importSession).not.toHaveBeenCalled();
  });

  it('never recovers or discards the active session', async () => {
    const { service, store } = setup();
    await service.start(request);
    await expect(service.recover(SESSION)).resolves.toMatchObject({ ok: false });
    await expect(service.discard(SESSION)).resolves.toMatchObject({ ok: false });
    await service.listInterrupted();
    expect(store.listInterrupted).toHaveBeenCalledWith(SESSION);
  });
});
