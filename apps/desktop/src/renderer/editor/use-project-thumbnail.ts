import { useEffect, useRef } from 'react';

import type { ProjectSnapshot } from '@usee/contracts';

import type { ThumbnailRequest, ThumbnailResponse } from './thumbnail-worker';

/** The picture a project is known by: a second in, or halfway through a shorter one. */
const THUMBNAIL_AT_US = 1_000_000;

/**
 * Gives the open project a thumbnail for the project list when it has none:
 * a background worker decodes one frame of its first recording and makes a
 * small JPEG, which main keeps beside the project. Once per opened project.
 */
export function useProjectThumbnail(
  project: ProjectSnapshot | null,
  needed: boolean,
  /** Called once it is kept, so the list can show it, whenever it lands. */
  onSaved: () => void,
): void {
  const latest = useRef(project);
  const saved = useRef(onSaved);
  useEffect(() => {
    latest.current = project;
    saved.current = onSaved;
  });
  const key = needed && project !== null ? project.projectId : '';

  useEffect(() => {
    const asset = latest.current?.assets.find((candidate) => candidate.kind === 'video');
    if (key === '' || asset === undefined) {
      return;
    }
    const worker = new Worker(new URL('./thumbnail-worker.ts', import.meta.url), {
      type: 'module',
    });
    let stopped = false;
    worker.onmessage = ({ data }: MessageEvent<ThumbnailResponse>) => {
      worker.terminate();
      if (!stopped && data.jpeg !== null) {
        void window.desktop
          .saveProjectThumbnail({ jpeg: new Uint8Array(data.jpeg) })
          .then((result) => {
            if (result.ok) saved.current();
          });
      }
    };
    worker.onerror = () => worker.terminate();
    worker.postMessage({
      mediaUrl: asset.mediaUrl,
      atUs: Math.min(THUMBNAIL_AT_US, asset.durationUs / 2),
    } satisfies ThumbnailRequest);
    return () => {
      stopped = true;
      worker.terminate();
    };
  }, [key]);
}
