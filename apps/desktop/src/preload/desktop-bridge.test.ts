import type { IpcRendererEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import {
  desktopEventChannels,
  desktopInvokeChannels,
  ok,
  type RecordingState,
  type RuntimeInfo,
} from '@usee/contracts';

import { createDesktopBridge } from './desktop-bridge';

const runtimeInfo: RuntimeInfo = {
  applicationName: 'usee',
  applicationVersion: '0.1.0',
  platform: 'win32',
  architecture: 'x64',
  versions: { electron: '44.8.0', chrome: '152.0.0.0', node: '24.22.0' },
};

type Handler = (event: IpcRendererEvent, payload: unknown) => void;

function bridgeReplying(reply: () => Promise<unknown>) {
  const invoke = vi.fn(reply);
  const handlers = new Map<string, Handler>();
  const bridge = createDesktopBridge(
    {
      invoke,
      on: (channel, handler) => {
        handlers.set(channel, handler as Handler);
        return undefined as never;
      },
      removeListener: (channel) => {
        handlers.delete(channel);
        return undefined as never;
      },
    },
    () => 'local-1',
  );
  const emit = (channel: string, payload: unknown) =>
    handlers.get(channel)?.({} as IpcRendererEvent, payload);
  return { bridge, invoke, handlers, emit };
}

describe('createDesktopBridge', () => {
  it('exposes a frozen object with exactly the documented methods', () => {
    const { bridge } = bridgeReplying(() => Promise.resolve(ok(runtimeInfo)));
    expect(Object.isFrozen(bridge)).toBe(true);
    expect(Object.keys(bridge).sort()).toEqual(
      [
        'chooseRecordingRegion',
        'closeProject',
        'discardRecording',
        'cancelExport',
        'editProject',
        'finishRegionChoice',
        'getPictureChanges',
        'getPointerTrack',
        'getProject',
        'getExportFrameContext',
        'getExportQueue',
        'getRecordingState',
        'getRuntimeInfo',
        'getSettings',
        'getWaveform',
        'listInterruptedRecordings',
        'listProjects',
        'listRecordingSources',
        'onProjectChanged',
        'onExportFrameRequested',
        'onExportQueueChanged',
        'onRecordingStateChanged',
        'openProject',
        'queueExport',
        'recoverRecording',
        'redoProjectEdit',
        'savePictureChanges',
        'saveProject',
        'saveProjectThumbnail',
        'showProjectsFolder',
        'startRecording',
        'submitExportFrame',
        'stopRecording',
        'undoProjectEdit',
        'updateSettings',
      ].sort(),
    );
  });

  it('invokes the allow-listed channel and returns the validated reply', async () => {
    const { bridge, invoke } = bridgeReplying(() => Promise.resolve(ok(runtimeInfo)));
    await expect(bridge.getRuntimeInfo()).resolves.toEqual(ok(runtimeInfo));
    expect(invoke).toHaveBeenCalledWith(desktopInvokeChannels.getRuntimeInfo.channel, undefined);
  });

  it('sends export frame data only through its named, schema-validated method', async () => {
    const { bridge, invoke } = bridgeReplying(() => Promise.resolve(ok(null)));
    const request = {
      exportJobId: 'job-1' as never,
      requestId: 'frame-1',
      frame: new Uint8Array([1, 2, 3]),
    };
    await expect(bridge.submitExportFrame(request)).resolves.toEqual(ok(null));
    expect(invoke).toHaveBeenCalledWith(desktopInvokeChannels.submitExportFrame.channel, request);
  });

  it('turns a failed invoke into a retryable error instead of rejecting', async () => {
    const { bridge } = bridgeReplying(() => Promise.reject(new Error('main process gone')));
    await expect(bridge.getRuntimeInfo()).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'ipc.unavailable',
        retryable: true,
        correlationId: 'local-1',
      }) as unknown,
    });
  });

  it.each([
    undefined,
    'ok',
    { ok: true, value: { applicationName: 42 } },
    { ok: false, error: 'x' },
  ])('rejects the malformed reply %j', async (reply) => {
    const { bridge } = bridgeReplying(() => Promise.resolve(reply));
    await expect(bridge.getRuntimeInfo()).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'ipc.invalid-response', retryable: false }) as unknown,
    });
  });

  it('delivers valid recording-state events, drops malformed ones, and unsubscribes', () => {
    const { bridge, emit, handlers } = bridgeReplying(() => Promise.resolve(undefined));
    const channel = desktopEventChannels.recordingStateChanged.channel;
    const received: RecordingState[] = [];

    const unsubscribe = bridge.onRecordingStateChanged((state) => received.push(state));
    emit(channel, { phase: 'preparing', sessionId: 'session-1' });
    emit(channel, { phase: 'recording', sessionId: 'session-1' }); // missing fields
    emit(channel, { phase: 'exploded' });
    expect(received).toEqual([{ phase: 'preparing', sessionId: 'session-1' }]);

    unsubscribe();
    expect(handlers.has(channel)).toBe(false);
  });
});
