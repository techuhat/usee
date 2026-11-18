import { describe, expect, it, vi } from 'vitest';

import {
  asCorrelationId,
  createAppError,
  err,
  ok,
  type DesktopBridge,
  type RecordingState,
} from '@usee/contracts';

import { formatDuration } from './format';
import { captureSourceOf, createRecordingStore, type RecordingBridge } from './recording-store';

const display = (id: string, isPrimary: boolean) => ({
  id,
  name: id,
  x: 0,
  y: 0,
  width: 1920,
  height: 1080,
  isPrimary,
  refreshRateHz: 60,
});

const AREA = { x: 100, y: 50, width: 640, height: 360 };

const openWindow = (id: string) => ({ id, title: `Notes ${id}`, width: 800, height: 600 });

function fakeBridge() {
  let push: (state: RecordingState) => void = () => undefined;
  const bridge = {
    listRecordingSources: vi.fn(() =>
      Promise.resolve(
        ok({
          displays: [display('display-2', false), display('display-1', true)],
          windows: [openWindow('window-a'), openWindow('window-b')],
          audioInputs: [],
        }),
      ),
    ),
    getRecordingState: vi.fn(() => Promise.resolve(ok<RecordingState>({ phase: 'idle' }))),
    startRecording: vi.fn<DesktopBridge['startRecording']>(() =>
      Promise.resolve(ok<RecordingState>({ phase: 'preparing', sessionId: 's1' })),
    ),
    stopRecording: vi.fn(),
    chooseRecordingRegion: vi.fn<DesktopBridge['chooseRecordingRegion']>(() =>
      Promise.resolve(ok({ region: AREA })),
    ),
    onRecordingStateChanged: vi.fn((listener: (state: RecordingState) => void) => {
      push = listener;
      return () => undefined;
    }),
    listInterruptedRecordings: vi.fn(() => Promise.resolve(ok([]))),
    recoverRecording: vi.fn(),
    discardRecording: vi.fn(),
  } satisfies RecordingBridge;
  return { bridge, push: (state: RecordingState) => push(state) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('recording store', () => {
  it('selects the primary display and leaves the microphone off by default', async () => {
    const { bridge } = fakeBridge();
    const store = createRecordingStore(bridge);
    store.getState().initialize();
    await flush();
    expect(store.getState().selection).toEqual({
      sourceKind: 'display',
      displayId: 'display-1',
      windowId: 'window-a',
      region: null,
      audioInputId: null,
      frameRate: 60,
      includeCursor: true,
      trackPointer: true,
    });
  });

  it('starts with the current selection and follows state events', async () => {
    const { bridge, push } = fakeBridge();
    const store = createRecordingStore(bridge);
    store.getState().initialize();
    await flush();
    store.getState().select({ frameRate: 30, audioInputId: 'audio-1' });

    await store.getState().start();
    expect(bridge.startRecording).toHaveBeenCalledWith({
      source: { kind: 'display', displayId: 'display-1' },
      audioInputId: 'audio-1',
      frameRate: 30,
      includeCursor: true,
      trackPointer: true,
    });

    push({ phase: 'finalizing', sessionId: 's1' });
    expect(store.getState().recording).toEqual({ phase: 'finalizing', sessionId: 's1' });
  });

  it('records the chosen window, and moves off one that has closed', async () => {
    const { bridge } = fakeBridge();
    const store = createRecordingStore(bridge);
    store.getState().initialize();
    await flush();
    store.getState().select({ sourceKind: 'window', windowId: 'window-b' });

    await store.getState().start();
    expect(bridge.startRecording).toHaveBeenCalledWith(
      expect.objectContaining({ source: { kind: 'window', windowId: 'window-b' } }),
    );

    bridge.listRecordingSources.mockResolvedValueOnce(
      ok({
        displays: [display('display-1', true)],
        windows: [openWindow('window-a')],
        audioInputs: [],
      }),
    );
    await store.getState().refreshSources();
    expect(store.getState().selection).toMatchObject({
      sourceKind: 'window',
      displayId: 'display-1',
      windowId: 'window-a',
    });
  });

  it('records the area chosen on a display, until another display is chosen', async () => {
    const { bridge } = fakeBridge();
    const store = createRecordingStore(bridge);
    store.getState().initialize();
    await flush();
    store.getState().select({ sourceKind: 'region' });
    expect(captureSourceOf(store.getState().selection)).toBeUndefined();

    await store.getState().chooseRegion();
    expect(bridge.chooseRecordingRegion).toHaveBeenCalledWith({ displayId: 'display-1' });
    await store.getState().start();
    expect(bridge.startRecording).toHaveBeenCalledWith(
      expect.objectContaining({ source: { kind: 'region', displayId: 'display-1', region: AREA } }),
    );

    // A cancelled picker keeps the area there was; another display has none yet.
    bridge.chooseRecordingRegion.mockResolvedValueOnce(ok({ region: null }));
    await store.getState().chooseRegion();
    expect(store.getState().selection.region).toEqual(AREA);
    store.getState().select({ displayId: 'display-2' });
    expect(store.getState().selection.region).toBeNull();
  });

  it('cannot start a window recording while no window is open', async () => {
    const { bridge } = fakeBridge();
    bridge.listRecordingSources.mockResolvedValueOnce(
      ok({ displays: [display('display-1', true)], windows: [], audioInputs: [] }),
    );
    const store = createRecordingStore(bridge);
    store.getState().initialize();
    await flush();
    store.getState().select({ sourceKind: 'window' });

    expect(captureSourceOf(store.getState().selection)).toBeUndefined();
    await store.getState().start();
    expect(bridge.startRecording).not.toHaveBeenCalled();
  });

  it('surfaces a failed action without throwing', async () => {
    const { bridge } = fakeBridge();
    const failure = createAppError({
      category: 'capture',
      code: 'capture.session-active',
      retryable: false,
      userMessageKey: 'errors.capture.session-active',
      correlationId: asCorrelationId('corr'),
    });
    bridge.startRecording.mockResolvedValueOnce(err(failure));
    const store = createRecordingStore(bridge);
    store.getState().initialize();
    await flush();

    await store.getState().start();
    expect(store.getState()).toMatchObject({ busy: false, actionError: failure });
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0:00'],
    [59_999_999, '0:59'],
    [61_000_000, '1:01'],
    [3_723_000_000, '1:02:03'],
  ])('formats %d µs as %s', (input, expected) => {
    expect(formatDuration(input)).toBe(expected);
  });
});
