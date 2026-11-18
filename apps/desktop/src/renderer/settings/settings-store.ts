import { createStore, type StoreApi } from 'zustand/vanilla';

import type { AppError, AppSettings, DesktopBridge, UpdateSettingsRequest } from '@usee/contracts';

export interface SettingsViewState {
  /** Main's snapshot, with any change still on its way applied; undefined until it loads. */
  readonly settings: AppSettings | undefined;
  readonly error: AppError | undefined;
}

export interface SettingsActions {
  readonly initialize: () => Promise<void>;
  /** Shows the change at once; main's answer, or a fresh read after a failure, is the truth. */
  readonly update: (request: UpdateSettingsRequest) => Promise<void>;
  readonly dismissError: () => void;
}

export type SettingsStore = StoreApi<SettingsViewState & SettingsActions>;

export type SettingsBridge = Pick<DesktopBridge, 'getSettings' | 'updateSettings'>;

/** Renderer-side view of the user's settings (ADR-005): main owns and saves them. */
export function createSettingsStore(bridge: SettingsBridge): SettingsStore {
  return createStore<SettingsViewState & SettingsActions>()((set) => ({
    settings: undefined,
    error: undefined,

    async initialize() {
      const result = await bridge.getSettings();
      set(result.ok ? { settings: result.value, error: undefined } : { error: result.error });
    },

    async update(request) {
      set((state) =>
        state.settings === undefined ? {} : { settings: { ...state.settings, ...request } },
      );
      const result = await bridge.updateSettings(request);
      if (result.ok) {
        set({ settings: result.value, error: undefined });
        return;
      }
      set({ error: result.error });
      const current = await bridge.getSettings();
      if (current.ok) {
        set({ settings: current.value });
      }
    },

    dismissError() {
      set({ error: undefined });
    },
  }));
}
