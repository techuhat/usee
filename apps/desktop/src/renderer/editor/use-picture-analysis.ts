import { useEffect, useRef, useState } from 'react';

import type { ProjectSnapshot } from '@usee/contracts';

import { PICTURE_SAMPLE_INTERVAL_US } from './picture-change-analysis';
import type { PictureReadRequest, PictureReadResponse } from './picture-change-worker';

export type PictureAnalysisState =
  | { readonly status: 'off' }
  | { readonly status: 'reading'; readonly progress: number }
  | { readonly status: 'done' }
  | { readonly status: 'unsupported' }
  | { readonly status: 'failed' };

/** Reads one recording in a background worker; the promise settles with its answer. */
function readPicture(
  request: PictureReadRequest,
  onProgress: (progress: number) => void,
  workers: Set<Worker>,
): Promise<PictureReadResponse> {
  const worker = new Worker(new URL('./picture-change-worker.ts', import.meta.url), {
    type: 'module',
  });
  workers.add(worker);
  return new Promise<PictureReadResponse>((resolve) => {
    worker.onmessage = ({ data }: MessageEvent<PictureReadResponse>) => {
      if (data.type === 'progress') {
        onProgress(data.progress);
      } else {
        resolve(data);
      }
    };
    worker.onerror = () => resolve({ type: 'failed' });
    worker.postMessage(request);
  }).finally(() => {
    worker.terminate();
    workers.delete(worker);
  });
}

/**
 * While picture focus is on, reads the picture of each recording the
 * automatic camera follows (a video with a recorded pointer) that has not
 * been read, one at a time in the background, and gives main what changed;
 * main then plans the camera again. Closing the project stops it.
 */
export function usePictureAnalysis(
  project: ProjectSnapshot | null,
  enabled: boolean,
): PictureAnalysisState {
  const [state, setState] = useState<PictureAnalysisState>({ status: 'off' });
  // The effect below reads the project as it is when the key changes, not on every edit.
  const latest = useRef(project);
  useEffect(() => {
    latest.current = project;
  });
  const targets =
    project?.assets.filter((asset) => asset.kind === 'video' && asset.pointer !== null) ?? [];
  const key =
    enabled && project !== null
      ? `${project.projectId}:${targets.map((asset) => asset.id).join(',')}`
      : '';

  useEffect(() => {
    if (key === '') {
      return;
    }
    let stopped = false;
    const workers = new Set<Worker>();
    const assets =
      latest.current?.assets.filter((asset) => asset.kind === 'video' && asset.pointer !== null) ??
      [];
    void (async () => {
      for (const [index, asset] of assets.entries()) {
        const existing = await window.desktop.getPictureChanges({ assetId: asset.id });
        if (stopped) return;
        if (existing.ok && existing.value !== null) continue;
        const share = (progress: number) => (index + progress) / assets.length;
        setState({ status: 'reading', progress: share(0) });
        const answer = await readPicture(
          { mediaUrl: asset.mediaUrl, durationUs: asset.durationUs },
          (progress) => {
            if (!stopped) setState({ status: 'reading', progress: share(progress) });
          },
          workers,
        );
        if (stopped) return;
        if (answer.type !== 'done') {
          setState({ status: answer.type === 'unsupported' ? 'unsupported' : 'failed' });
          return;
        }
        const saved = await window.desktop.savePictureChanges({
          assetId: asset.id,
          analysis: {
            algorithm: 'cell-luma-v1',
            sampleIntervalUs: PICTURE_SAMPLE_INTERVAL_US,
            changes: answer.changes,
          },
        });
        if (stopped) return;
        if (!saved.ok) {
          setState({ status: 'failed' });
          return;
        }
      }
      if (!stopped) setState({ status: 'done' });
    })();
    return () => {
      stopped = true;
      for (const worker of workers) worker.terminate();
    };
  }, [key]);

  return key === '' ? { status: 'off' } : state;
}
