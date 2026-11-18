import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import {
  asCorrelationId,
  createAppError,
  desktopInvokeChannels,
  err,
  ok,
  type RuntimeInfo,
} from '@usee/contracts';

import { createInvokeRouter, type InvokeRouterOptions } from './invoke-router';

const runtimeInfo: RuntimeInfo = {
  applicationName: 'usee',
  applicationVersion: '0.1.0',
  platform: 'win32',
  architecture: 'x64',
  versions: { electron: '44.8.0', chrome: '152.0.0.0', node: '24.22.0' },
};

const TRUSTED_FRAME = 'app://renderer/index.html';
const channel = desktopInvokeChannels.getRuntimeInfo;

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function setup(overrides: Partial<InvokeRouterOptions> = {}) {
  const listeners = new Map<string, Listener>();
  const ipc: Pick<IpcMain, 'handle'> = {
    handle: (name, listener) => {
      listeners.set(name, listener);
    },
  };
  const onHandlerFailure = vi.fn();
  const router = createInvokeRouter(ipc, {
    isTrustedSender: (url) => url === TRUSTED_FRAME,
    createCorrelationId: () => asCorrelationId('corr-1'),
    onHandlerFailure,
    ...overrides,
  });

  const invoke = async (frameUrl: string | null, ...args: unknown[]): Promise<unknown> => {
    const listener = listeners.get(channel.channel);
    if (listener === undefined) {
      throw new Error('No handler registered.');
    }
    const event = { senderFrame: frameUrl === null ? null : { url: frameUrl } };
    return await listener(event as unknown as IpcMainInvokeEvent, ...args);
  };

  return { router, invoke, onHandlerFailure };
}

const failure = (code: string) => ({
  ok: false,
  error: expect.objectContaining({ category: 'ipc', code, correlationId: 'corr-1' }) as unknown,
});

describe('createInvokeRouter', () => {
  it('returns the validated handler result to a trusted frame', async () => {
    const { router, invoke } = setup();
    router.handle(channel, () => ok(runtimeInfo));
    await expect(invoke(TRUSTED_FRAME, undefined)).resolves.toEqual(ok(runtimeInfo));
  });

  it('rejects untrusted or destroyed frames before running the handler', async () => {
    const { router, invoke } = setup();
    const handler = vi.fn(() => ok(runtimeInfo));
    router.handle(channel, handler);

    await expect(invoke('https://evil.example/', undefined)).resolves.toEqual(
      failure('ipc.untrusted-sender'),
    );
    await expect(invoke(null, undefined)).resolves.toEqual(failure('ipc.untrusted-sender'));
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects requests that do not match the channel schema', async () => {
    const { router, invoke } = setup();
    const handler = vi.fn(() => ok(runtimeInfo));
    router.handle(channel, handler);

    await expect(invoke(TRUSTED_FRAME, { path: 'C:/Windows' })).resolves.toEqual(
      failure('ipc.invalid-request'),
    );
    await expect(invoke(TRUSTED_FRAME, undefined, 'extra')).resolves.toEqual(
      failure('ipc.invalid-request'),
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('converts a throwing handler into a redacted error and reports it locally', async () => {
    const { router, invoke, onHandlerFailure } = setup();
    const cause = new Error('C:\\Users\\someone\\secret.txt is locked');
    router.handle(channel, () => {
      throw cause;
    });

    const reply = await invoke(TRUSTED_FRAME, undefined);
    expect(reply).toEqual(failure('ipc.handler-failed'));
    expect(JSON.stringify(reply)).not.toContain('secret');
    expect(onHandlerFailure).toHaveBeenCalledWith({
      channel: channel.channel,
      correlationId: 'corr-1',
      cause,
    });
  });

  it('refuses to forward a response that breaks the channel schema', async () => {
    const { router, invoke, onHandlerFailure } = setup();
    router.handle(channel, () => ok({ ...runtimeInfo, applicationName: '' }));
    await expect(invoke(TRUSTED_FRAME, undefined)).resolves.toEqual(
      failure('ipc.invalid-response'),
    );
    expect(onHandlerFailure).toHaveBeenCalledOnce();
  });

  it('passes a handler failure through unchanged', async () => {
    const { router, invoke } = setup();
    const handlerError = createAppError({
      category: 'native',
      code: 'native.host-unavailable',
      retryable: true,
      userMessageKey: 'errors.native.host-unavailable',
      correlationId: asCorrelationId('corr-1'),
    });
    router.handle(channel, () => err(handlerError));
    await expect(invoke(TRUSTED_FRAME, undefined)).resolves.toEqual(err(handlerError));
  });

  it('refuses to register a second handler for the same channel', () => {
    const { router } = setup();
    router.handle(channel, () => ok(runtimeInfo));
    expect(() => router.handle(channel, () => ok(runtimeInfo))).toThrow(/already registered/);
  });
});
