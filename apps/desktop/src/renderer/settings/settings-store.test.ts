import { describe, expect, it, vi } from 'vitest';

import {
  asCorrelationId,
  createAppError,
  err,
  ok,
  type AppSettings,
  type UpdateSettingsRequest,
} from '@usee/contracts';

import { createSettingsStore, type SettingsBridge } from './settings-store';

const saved: AppSettings = {
  settingsVersion: 1,
  recording: { frameRate: 60, trackPointer: true, includeCursor: true },
  newProjects: {
    autoZoom: true,
    zoomScale: 2,
    turn3d: 0,
    canvas: {
      aspect: 'source',
      background: { kind: 'solid', color: '#0b1020' },
      padding: 0,
      cornerRadius: 0,
      shadow: { opacity: 0, blur: 0.04, offsetY: 0.01 },
    },
  },
  export: { presetId: 'mp4-h264-1080p30' },
};

const writeFailed = createAppError({
  category: 'storage',
  code: 'storage.settings-write-failed',
  retryable: true,
  userMessageKey: 'errors.storage.settings-write-failed',
  correlationId: asCorrelationId('settings-store-test'),
});

function bridgeWith(update: (request: UpdateSettingsRequest) => AppSettings | undefined) {
  const bridge: SettingsBridge = {
    getSettings: vi.fn(() => Promise.resolve(ok(saved))),
    updateSettings: vi.fn((request: UpdateSettingsRequest) => {
      const next = update(request);
      return Promise.resolve(next === undefined ? err(writeFailed) : ok(next));
    }),
  };
  return bridge;
}

describe('the settings store', () => {
  it('loads main’s settings', async () => {
    const store = createSettingsStore(bridgeWith(() => undefined));
    expect(store.getState().settings).toBeUndefined();
    await store.getState().initialize();
    expect(store.getState().settings).toEqual(saved);
  });

  it('shows a change at once, then keeps what main saved', async () => {
    const store = createSettingsStore(bridgeWith((request) => ({ ...saved, ...request })));
    await store.getState().initialize();
    const change = store.getState().update({ export: { presetId: 'mp4-h264-4k30' } });
    expect(store.getState().settings?.export.presetId).toBe('mp4-h264-4k30');
    await change;
    expect(store.getState().settings?.export.presetId).toBe('mp4-h264-4k30');
    expect(store.getState().error).toBeUndefined();
  });

  it('puts the saved settings back and says why when a change fails', async () => {
    const store = createSettingsStore(bridgeWith(() => undefined));
    await store.getState().initialize();
    await store.getState().update({ export: { presetId: 'mp4-h264-4k30' } });
    expect(store.getState().settings).toEqual(saved);
    expect(store.getState().error?.code).toBe('storage.settings-write-failed');
    store.getState().dismissError();
    expect(store.getState().error).toBeUndefined();
  });
});
