import { createStore, type StoreApi } from 'zustand/vanilla';

import type {
  AppError,
  AssetId,
  DesktopBridge,
  PointerTrackDto,
  ProjectSnapshot,
  ProjectSummary,
  Result,
  ProjectCommandRequest,
} from '@usee/contracts';
import type { PointerTrack } from '@usee/domain';

/** The part of the bridge that projects use. */
export type ProjectBridge = Pick<
  DesktopBridge,
  | 'listProjects'
  | 'openProject'
  | 'getProject'
  | 'closeProject'
  | 'editProject'
  | 'undoProjectEdit'
  | 'redoProjectEdit'
  | 'saveProject'
  | 'getWaveform'
  | 'getPointerTrack'
  | 'onProjectChanged'
>;

/** An asset's audio peaks, 0-255, `peaksPerSecond` of them per second. */
export interface DecodedWaveform {
  readonly peaksPerSecond: number;
  readonly peaks: Uint8Array;
}

export interface ProjectViewState {
  /** Main's latest snapshot of the open project; the renderer never edits it. */
  readonly project: ProjectSnapshot | null;
  readonly recent: readonly ProjectSummary[];
  /** Where the open project is, when it was opened by path; null when none is open. */
  readonly openPath: string | null;
  readonly opening: boolean;
  readonly error: AppError | undefined;
  /** Waveforms by asset ID; null while loading or when the asset has none. */
  readonly waveforms: Readonly<Record<string, DecodedWaveform | null>>;
  /** Pointer streams by their asset ID; null while loading or when unreadable. */
  readonly pointerTracks: Readonly<Record<string, PointerTrack | null>>;
}

export interface ProjectActions {
  /** Subscribes to main's project events; returns the unsubscribe function. */
  readonly initialize: () => () => void;
  readonly refreshRecent: () => Promise<void>;
  readonly open: (projectPath: string) => Promise<void>;
  readonly close: () => Promise<void>;
  readonly edit: (command: ProjectCommandRequest) => Promise<void>;
  readonly undo: () => Promise<void>;
  readonly redo: () => Promise<void>;
  readonly save: () => Promise<void>;
  readonly loadWaveform: (assetId: AssetId) => Promise<void>;
  readonly loadPointerTrack: (streamId: AssetId) => Promise<void>;
  readonly dismissError: () => void;
}

export type ProjectStore = StoreApi<ProjectViewState & ProjectActions>;

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * The columns as typed arrays over the decoded bytes, which are little-endian
 * like every platform the app runs on. A fresh buffer is always aligned.
 */
export function decodePointerTrack(dto: PointerTrackDto): PointerTrack | null {
  const times = decodeBase64(dto.moveTimes);
  const xs = decodeBase64(dto.moveXs);
  const ys = decodeBase64(dto.moveYs);
  const count = times.byteLength / Float64Array.BYTES_PER_ELEMENT;
  if (
    !Number.isInteger(count) ||
    xs.byteLength !== count * Float32Array.BYTES_PER_ELEMENT ||
    ys.byteLength !== xs.byteLength
  ) {
    return null;
  }
  return {
    display: dto.display,
    moveTimes: new Float64Array(times.buffer),
    moveXs: new Float32Array(xs.buffer),
    moveYs: new Float32Array(ys.buffer),
    clicks: dto.clicks,
    shapes: dto.shapes,
    visibility: dto.visibility,
  };
}

/**
 * The renderer's view of the open project (ADR-005). Main owns the project
 * and its history; this store keeps the newest snapshot it has seen, and sends
 * every change back as a semantic command.
 */
export function createProjectStore(bridge: ProjectBridge): ProjectStore {
  return createStore<ProjectViewState & ProjectActions>()((set, get) => {
    /** Keeps a snapshot unless an equal or newer one of the same project is already here. */
    function accept(next: ProjectSnapshot | null): void {
      const current = get().project;
      if (
        next === null ||
        current === null ||
        next.projectId !== current.projectId ||
        next.revision >= current.revision
      ) {
        const switched = next?.projectId !== current?.projectId;
        set({ project: next, ...(switched ? { waveforms: {}, pointerTracks: {} } : {}) });
      }
    }

    async function run(call: () => Promise<Result<ProjectSnapshot>>): Promise<void> {
      const result = await call();
      if (result.ok) {
        accept(result.value);
      } else {
        set({ error: result.error });
      }
    }

    return {
      project: null,
      recent: [],
      openPath: null,
      opening: false,
      error: undefined,
      waveforms: {},
      pointerTracks: {},

      initialize: () => {
        const unsubscribe = bridge.onProjectChanged(accept);
        void bridge.getProject().then((result) => {
          if (result.ok) {
            accept(result.value);
          }
        });
        void get().refreshRecent();
        return unsubscribe;
      },

      refreshRecent: async () => {
        const result = await bridge.listProjects();
        if (result.ok) {
          set({ recent: result.value });
        }
      },

      open: async (projectPath) => {
        set({ opening: true, error: undefined });
        const result = await bridge.openProject({ projectPath });
        if (result.ok) {
          // An explicit open replaces whatever was shown, whatever its revision.
          set({ project: result.value, openPath: projectPath, waveforms: {}, pointerTracks: {} });
        } else {
          set({ error: result.error });
        }
        set({ opening: false });
      },

      close: async () => {
        const result = await bridge.closeProject();
        if (result.ok) {
          set({ project: null, openPath: null, waveforms: {}, pointerTracks: {} });
          await get().refreshRecent();
        } else {
          set({ error: result.error });
        }
      },

      edit: (command) => run(() => bridge.editProject({ command })),
      undo: () => run(() => bridge.undoProjectEdit()),
      redo: () => run(() => bridge.redoProjectEdit()),
      save: () => run(() => bridge.saveProject()),

      loadWaveform: async (assetId) => {
        if (assetId in get().waveforms) {
          return;
        }
        set({ waveforms: { ...get().waveforms, [assetId]: null } });
        const result = await bridge.getWaveform({ assetId });
        if (result.ok && result.value !== null) {
          const waveform = {
            peaksPerSecond: result.value.peaksPerSecond,
            peaks: decodeBase64(result.value.peaks),
          };
          set({ waveforms: { ...get().waveforms, [assetId]: waveform } });
        }
      },

      loadPointerTrack: async (streamId) => {
        if (streamId in get().pointerTracks) {
          return;
        }
        set({ pointerTracks: { ...get().pointerTracks, [streamId]: null } });
        const result = await bridge.getPointerTrack({ assetId: streamId });
        const track = result.ok && result.value !== null ? decodePointerTrack(result.value) : null;
        if (track !== null) {
          set({ pointerTracks: { ...get().pointerTracks, [streamId]: track } });
        }
      },

      dismissError: () => set({ error: undefined }),
    };
  });
}
