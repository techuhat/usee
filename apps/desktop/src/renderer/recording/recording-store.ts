import { createStore, type StoreApi } from 'zustand/vanilla';

import type {
  AppError,
  CaptureSource,
  DesktopBridge,
  HostRegion,
  InterruptedRecording,
  RecordingSources,
  RecordingState,
  Result,
} from '@usee/contracts';

export interface RecordingSelection {
  /** A whole display, one window or an area of a display (ADR-009). */
  readonly sourceKind: CaptureSource['kind'];
  readonly displayId: string | null;
  readonly windowId: string | null;
  /** The area of the selected display, drawn on the area picker; it belongs to that display. */
  readonly region: HostRegion | null;
  /** Off until the user picks a microphone (docs/security.md, "Permissions and user intent"). */
  readonly audioInputId: string | null;
  readonly frameRate: 30 | 60;
  readonly includeCursor: boolean;
  /** Record pointer movement and clicks so the editor draws the cursor (never keystrokes). */
  readonly trackPointer: boolean;
}

export interface RecordingViewState {
  readonly sources: RecordingSources | undefined;
  readonly selection: RecordingSelection;
  readonly recording: RecordingState;
  readonly interrupted: readonly InterruptedRecording[];
  readonly busy: boolean;
  readonly actionError: AppError | undefined;
  readonly recoveredPath: string | undefined;
}

/** Plain functions over closures, so components can destructure them. */
export interface RecordingActions {
  /** Loads everything and subscribes to state changes; returns the cleanup. */
  readonly initialize: () => () => void;
  readonly select: (patch: Partial<RecordingSelection>) => void;
  /** Lists the sources again: windows open and close while Home is shown. */
  readonly refreshSources: () => Promise<void>;
  /** Opens the area picker over the selected display; a cancelled pick keeps the area there was. */
  readonly chooseRegion: () => Promise<void>;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly recover: (sessionId: string) => Promise<void>;
  readonly discard: (sessionId: string) => Promise<void>;
}

export type RecordingStore = StoreApi<RecordingViewState & RecordingActions>;

/** What the selection would record, or undefined while nothing is chosen. */
export function captureSourceOf(selection: RecordingSelection): CaptureSource | undefined {
  const { displayId, windowId, region } = selection;
  switch (selection.sourceKind) {
    case 'window':
      return windowId === null ? undefined : { kind: 'window', windowId };
    case 'region':
      return displayId === null || region === null
        ? undefined
        : { kind: 'region', displayId, region };
    case 'display':
      return displayId === null ? undefined : { kind: 'display', displayId };
  }
}

/** The selection with `patch` applied; an area is dropped with the display it belongs to. */
function withDisplay(
  selection: RecordingSelection,
  patch: Partial<RecordingSelection>,
): RecordingSelection {
  const next = { ...selection, ...patch };
  return next.displayId === selection.displayId ? next : { ...next, region: patch.region ?? null };
}

/** `id` while `items` still lists it. */
function stillListed(items: readonly { readonly id: string }[], id: string | null): string | null {
  return items.some((item) => item.id === id) ? id : null;
}

/** The part of the bridge that recording uses. */
export type RecordingBridge = Pick<
  DesktopBridge,
  | 'listRecordingSources'
  | 'chooseRecordingRegion'
  | 'getRecordingState'
  | 'startRecording'
  | 'stopRecording'
  | 'onRecordingStateChanged'
  | 'listInterruptedRecordings'
  | 'recoverRecording'
  | 'discardRecording'
>;

/**
 * Renderer-side view state for recording (ADR-005): a projection of main's
 * state plus the user's unsaved choices. It never owns the recording itself.
 */
export function createRecordingStore(bridge: RecordingBridge): RecordingStore {
  return createStore<RecordingViewState & RecordingActions>()((set, get) => {
    /** Runs one bridge call, tracking `busy` and surfacing any error. */
    async function run<Value>(call: () => Promise<Result<Value>>): Promise<Value | undefined> {
      set({ busy: true, actionError: undefined });
      const result = await call();
      set({ busy: false, ...(result.ok ? {} : { actionError: result.error }) });
      return result.ok ? result.value : undefined;
    }

    async function refreshSources(): Promise<void> {
      const sources = await run(() => bridge.listRecordingSources());
      if (sources === undefined) {
        return;
      }
      const preferred =
        sources.displays.find((display) => display.isPrimary) ?? sources.displays[0];
      set((state) => ({
        sources,
        selection: withDisplay(state.selection, {
          displayId:
            stillListed(sources.displays, state.selection.displayId) ?? preferred?.id ?? null,
          windowId:
            stillListed(sources.windows, state.selection.windowId) ??
            sources.windows[0]?.id ??
            null,
        }),
      }));
    }

    async function refreshInterrupted(): Promise<void> {
      const result = await bridge.listInterruptedRecordings();
      if (result.ok) {
        set({ interrupted: result.value });
      }
    }

    return {
      sources: undefined,
      selection: {
        sourceKind: 'display',
        displayId: null,
        windowId: null,
        region: null,
        audioInputId: null,
        frameRate: 60,
        includeCursor: true,
        trackPointer: true,
      },
      recording: { phase: 'idle' },
      interrupted: [],
      busy: false,
      actionError: undefined,
      recoveredPath: undefined,

      initialize() {
        const unsubscribe = bridge.onRecordingStateChanged((recording) => {
          set({ recording });
          if (recording.phase === 'completed' || recording.phase === 'failed') {
            void refreshInterrupted();
          }
        });
        void bridge.getRecordingState().then((result) => {
          if (result.ok) {
            set({ recording: result.value });
          }
        });
        void refreshSources();
        void refreshInterrupted();
        return unsubscribe;
      },

      select(patch) {
        set((state) => ({ selection: withDisplay(state.selection, patch) }));
      },

      refreshSources,

      async chooseRegion() {
        const { displayId } = get().selection;
        if (displayId === null) {
          return;
        }
        const chosen = await run(() => bridge.chooseRecordingRegion({ displayId }));
        const region = chosen?.region ?? null;
        if (region !== null && get().selection.displayId === displayId) {
          set((state) => ({ selection: { ...state.selection, region } }));
        }
      },

      async start() {
        const { selection } = get();
        const source = captureSourceOf(selection);
        if (source === undefined) {
          return;
        }
        const recording = await run(() =>
          bridge.startRecording({
            source,
            audioInputId: selection.audioInputId,
            frameRate: selection.frameRate,
            includeCursor: selection.includeCursor,
            trackPointer: selection.trackPointer,
          }),
        );
        if (recording !== undefined) {
          set({ recording, recoveredPath: undefined });
        }
      },

      async stop() {
        const recording = await run(() => bridge.stopRecording());
        if (recording !== undefined) {
          set({ recording });
        }
      },

      async recover(sessionId) {
        const recovered = await run(() => bridge.recoverRecording({ sessionId }));
        if (recovered !== undefined) {
          set({ recoveredPath: recovered.projectPath });
        }
        await refreshInterrupted();
      },

      async discard(sessionId) {
        await run(() => bridge.discardRecording({ sessionId }));
        await refreshInterrupted();
      },
    };
  });
}
