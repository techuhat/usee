import { createStore, type StoreApi } from 'zustand/vanilla';

export interface PlaybackState {
  /** Timeline position in microseconds. */
  readonly playheadUs: number;
  readonly playing: boolean;
  /** Grows with every user seek, so the player can tell a seek from its own progress. */
  readonly seekVersion: number;
}

export interface PlaybackActions {
  /** Moves the playhead as the user asked: the player shows that frame. */
  readonly seek: (timeUs: number) => void;
  /** The player reporting where playback has reached. */
  readonly advance: (timeUs: number) => void;
  readonly setPlaying: (playing: boolean) => void;
}

export type PlaybackStore = StoreApi<PlaybackState & PlaybackActions>;

/** Ephemeral preview state (docs/state-management.md): never part of the project. */
export function createPlaybackStore(): PlaybackStore {
  return createStore<PlaybackState & PlaybackActions>()((set) => ({
    playheadUs: 0,
    playing: false,
    seekVersion: 0,
    seek: (timeUs) =>
      set((state) => ({ playheadUs: Math.max(0, timeUs), seekVersion: state.seekVersion + 1 })),
    advance: (timeUs) => set({ playheadUs: Math.max(0, timeUs) }),
    setPlaying: (playing) => set({ playing }),
  }));
}
