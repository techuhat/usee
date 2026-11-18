import type { PictureChange } from '@usee/domain';

import { openOrderedFrameSource } from './export-video-decoder';
import {
  cellLuma,
  PICTURE_READ_SIZE,
  PICTURE_SAMPLE_INTERVAL_US,
  PictureChangeDetector,
} from './picture-change-analysis';

/** Reads one recording of the open project: its media URL and how long it is. */
export interface PictureReadRequest {
  readonly mediaUrl: string;
  readonly durationUs: number;
}

export type PictureReadResponse =
  | { readonly type: 'progress'; readonly progress: number }
  | { readonly type: 'done'; readonly changes: readonly PictureChange[] }
  /** This recording, or this machine, cannot be decoded in order. */
  | { readonly type: 'unsupported' }
  | { readonly type: 'failed' };

const scope = self as unknown as {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<PictureReadRequest>) => void,
  ): void;
  postMessage(message: PictureReadResponse): void;
};

/**
 * Decodes a recording in order in the background, ten frames a second, and
 * reads where its picture changes (picture-change-analysis.ts). Each frame is
 * drawn small on the GPU, so only a few thousand bytes are read back.
 */
async function read({ mediaUrl, durationUs }: PictureReadRequest): Promise<PictureReadResponse> {
  const source = await openOrderedFrameSource(mediaUrl).catch(() => undefined);
  if (source === undefined) {
    return { type: 'unsupported' };
  }
  const { width, height } = PICTURE_READ_SIZE;
  const context = new OffscreenCanvas(width, height).getContext('2d', { alpha: false });
  if (context === null) {
    source.close();
    return { type: 'unsupported' };
  }
  const detector = new PictureChangeDetector();
  try {
    let sample = 0;
    for (let timeUs = 0; timeUs <= durationUs; timeUs += PICTURE_SAMPLE_INTERVAL_US) {
      const frame = await source.frameAt(timeUs);
      context.drawImage(frame, 0, 0, width, height);
      frame.close();
      detector.push(
        timeUs,
        cellLuma(context.getImageData(0, 0, width, height).data, width, height),
      );
      sample += 1;
      if (sample % 10 === 0) {
        scope.postMessage({ type: 'progress', progress: Math.min(1, timeUs / durationUs) });
      }
    }
    return { type: 'done', changes: detector.changes };
  } catch {
    return { type: 'failed' };
  } finally {
    source.close();
  }
}

scope.addEventListener('message', (event) => {
  void read(event.data).then((response) => scope.postMessage(response));
});
