import { useEffect, useRef, useState } from 'react';

import type { ProjectSnapshot } from '@usee/contracts';

import type { FilmstripFrame } from './filmstrip';
import type { FilmstripRequest, FilmstripResponse } from './filmstrip-worker';

/** Each picture is made this many device pixels tall: a clip's height, sharp on a 2× screen. */
const FILMSTRIP_HEIGHT_PX = 100;

/**
 * The timeline's filmstrips: each video recording of the open project, read
 * at its keyframes in a background worker, one recording at a time. The
 * pictures arrive as they are made; closing the project stops and frees them.
 */
export function useFilmstrips(
  project: ProjectSnapshot | null,
): ReadonlyMap<string, readonly FilmstripFrame[]> {
  const [strips, setStrips] = useState<ReadonlyMap<string, readonly FilmstripFrame[]>>(
    () => new Map(),
  );
  const latest = useRef(project);
  useEffect(() => {
    latest.current = project;
  });
  const key = project === null ? '' : project.projectId;

  useEffect(() => {
    const assets = latest.current?.assets.filter((asset) => asset.kind === 'video') ?? [];
    if (key === '' || assets.length === 0) {
      return;
    }
    let stopped = false;
    const made = new Map<string, FilmstripFrame[]>();
    let worker: Worker | undefined;
    // Pictures land in batches, so the timeline redraws a few times, not per picture.
    let pending: ReturnType<typeof setTimeout> | undefined;
    const publish = () => {
      pending ??= setTimeout(() => {
        pending = undefined;
        if (!stopped) setStrips(new Map([...made].map(([id, frames]) => [id, [...frames]])));
      }, 150);
    };

    void (async () => {
      for (const asset of assets) {
        if (stopped) return;
        const frames: FilmstripFrame[] = [];
        made.set(asset.id, frames);
        worker = new Worker(new URL('./filmstrip-worker.ts', import.meta.url), { type: 'module' });
        await new Promise<void>((resolve) => {
          if (worker === undefined) return resolve();
          // Bitmaps are made here, in order, so each belongs to this page, not the worker.
          let queue = Promise.resolve();
          worker.onmessage = ({ data }: MessageEvent<FilmstripResponse>) => {
            if (data.type === 'done') {
              void queue.then(resolve);
              return;
            }
            const pixels = new ImageData(
              new Uint8ClampedArray(data.pixels),
              data.width,
              data.height,
            );
            queue = queue.then(async () => {
              const bitmap = await createImageBitmap(pixels);
              if (stopped) {
                bitmap.close();
                return;
              }
              frames.push({ timeUs: data.timeUs, bitmap });
              publish();
            });
          };
          worker.onerror = () => resolve();
          worker.postMessage({
            mediaUrl: asset.mediaUrl,
            height: FILMSTRIP_HEIGHT_PX,
          } satisfies FilmstripRequest);
        });
        worker.terminate();
        worker = undefined;
      }
    })();

    return () => {
      stopped = true;
      worker?.terminate();
      if (pending !== undefined) clearTimeout(pending);
      for (const frames of made.values()) {
        for (const frame of frames) frame.bitmap.close();
      }
      setStrips(new Map());
    };
  }, [key]);

  return strips;
}
