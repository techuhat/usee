import { useEffect, useMemo, useRef, useState } from 'react';

import { deriveCursorPath, type CursorPath, type PointerTrack } from '@usee/domain';

import type { CursorPathWorkerRequest, CursorPathWorkerResult } from './cursor-path-worker';

interface DerivedPath {
  readonly track: PointerTrack;
  readonly smoothing: number;
  readonly path: CursorPath;
}

interface PendingPath {
  readonly requestId: number;
  readonly track: PointerTrack;
  readonly smoothing: number;
}

/** Keeps cursor-path smoothing off the renderer thread; the raw path is the immediate fallback. */
export function useCursorPaths(
  pointerTracks: Readonly<Record<string, PointerTrack | null>>,
  smoothing: number,
): ReadonlyMap<string, CursorPath> {
  const workerRef = useRef<Worker | null>(null);
  const pendingRef = useRef(new Map<string, PendingPath>());
  const pointerTracksRef = useRef(pointerTracks);
  const requestIdRef = useRef(0);
  const [smoothedPaths, setSmoothedPaths] = useState<ReadonlyMap<string, DerivedPath>>(
    () => new Map(),
  );

  useEffect(() => {
    if (!(smoothing > 0)) {
      return;
    }
    const pendingPaths = pendingRef.current;
    const worker = new Worker(new URL('./cursor-path-worker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;
    worker.onmessage = ({ data }: MessageEvent<CursorPathWorkerResult>) => {
      const pending = pendingRef.current.get(data.streamId);
      if (pending === undefined || pending.requestId !== data.requestId) {
        return;
      }
      const path: CursorPath = {
        display: pending.track.display,
        xs: data.xs,
        ys: data.ys,
        clicks: pending.track.clicks,
        shapes: pending.track.shapes,
        visibility: pending.track.visibility,
      };
      setSmoothedPaths((current) =>
        new Map(
          [...current].filter(
            ([streamId, derived]) =>
              pointerTracksRef.current[streamId] === derived.track &&
              derived.smoothing === pending.smoothing,
          ),
        ).set(data.streamId, { track: pending.track, smoothing: pending.smoothing, path }),
      );
    };
    worker.onerror = () => {
      worker.terminate();
      if (workerRef.current === worker) {
        workerRef.current = null;
        pendingPaths.clear();
      }
    };
    return () => {
      worker.terminate();
      if (workerRef.current === worker) {
        workerRef.current = null;
      }
      pendingPaths.clear();
    };
  }, [smoothing]);

  useEffect(() => {
    pointerTracksRef.current = pointerTracks;
    const worker = workerRef.current;
    for (const streamId of pendingRef.current.keys()) {
      if (pointerTracks[streamId] == null) {
        pendingRef.current.delete(streamId);
      }
    }
    if (worker === null || !(smoothing > 0)) {
      return;
    }
    for (const [streamId, track] of Object.entries(pointerTracks)) {
      if (track === null) {
        continue;
      }
      const pending = pendingRef.current.get(streamId);
      if (pending?.track === track && pending.smoothing === smoothing) {
        continue;
      }
      const requestId = ++requestIdRef.current;
      pendingRef.current.set(streamId, { requestId, track, smoothing });
      const request: CursorPathWorkerRequest = { requestId, streamId, track, smoothing };
      worker.postMessage(request);
    }
  }, [pointerTracks, smoothing]);

  const rawPaths = useMemo(() => {
    const paths = new Map<string, CursorPath>();
    for (const [streamId, track] of Object.entries(pointerTracks)) {
      if (track !== null) {
        paths.set(streamId, deriveCursorPath(track, 0));
      }
    }
    return paths;
  }, [pointerTracks]);

  return useMemo(() => {
    const paths = new Map<string, CursorPath>();
    for (const [streamId, track] of Object.entries(pointerTracks)) {
      if (track === null) {
        continue;
      }
      const raw = rawPaths.get(streamId);
      if (raw === undefined) {
        continue;
      }
      const derived = smoothedPaths.get(streamId);
      paths.set(
        streamId,
        smoothing > 0 && derived?.track === track && derived.smoothing === smoothing
          ? derived.path
          : raw,
      );
    }
    return paths;
  }, [pointerTracks, rawPaths, smoothedPaths, smoothing]);
}
