import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import {
  defineEventChannel,
  defineInvokeChannel,
  desktopEventChannels,
  desktopInvokeChannels,
  type EventChannel,
  type InvokeChannel,
} from './ipc';

const channelNames = (registry: Readonly<Record<string, EventChannel | InvokeChannel>>) =>
  Object.values(registry).map((definition) => definition.channel);

describe('IPC channel registry', () => {
  const channels = [...channelNames(desktopInvokeChannels), ...channelNames(desktopEventChannels)];

  it('uses unique channel names', () => {
    expect(new Set(channels).size).toBe(channels.length);
  });

  it('is frozen so no code can add a channel at runtime', () => {
    expect(Object.isFrozen(desktopInvokeChannels)).toBe(true);
    expect(Object.isFrozen(desktopInvokeChannels.getRuntimeInfo)).toBe(true);
  });

  it.each(['desktop.app.get-runtime-info', 'desktop.recording.state-changed'])(
    'accepts %s',
    (channel) => {
      expect(() =>
        defineInvokeChannel({ channel, request: z.undefined(), response: z.null() }),
      ).not.toThrow();
    },
  );

  it.each(['invoke', 'desktop', 'desktop.app', 'desktop.App.get', 'desktop.app.get_info', 'x.y.z'])(
    'rejects %s',
    (channel) => {
      expect(() => defineEventChannel({ channel, payload: z.null() })).toThrow(TypeError);
    },
  );

  it('accepts only an empty request for runtime info', () => {
    const { request } = desktopInvokeChannels.getRuntimeInfo;
    expect(request.safeParse(undefined).success).toBe(true);
    expect(request.safeParse({ path: 'C:/Windows' }).success).toBe(false);
  });
});
