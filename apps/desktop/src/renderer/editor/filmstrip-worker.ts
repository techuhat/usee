import { openOrderedFrameSource } from './export-video-decoder';
import { filmstripTimes } from './filmstrip';

/** Reads one recording's keyframes small, for the timeline's filmstrip. */
export interface FilmstripRequest {
  readonly mediaUrl: string;
  /** Pixels tall each picture is made: the clip's height on screen. */
  readonly height: number;
}

/**
 * Each picture as plain RGBA pixels: a bitmap made from a decoded frame here
 * belongs to this worker's GPU resources and goes blank once it ends, so the
 * editor makes its own bitmap from the pixels.
 */
export type FilmstripResponse =
  | {
      readonly type: 'frame';
      readonly timeUs: number;
      readonly width: number;
      readonly height: number;
      readonly pixels: ArrayBuffer;
    }
  | { readonly type: 'done' };

const scope = self as unknown as {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<FilmstripRequest>) => void,
  ): void;
  postMessage(message: FilmstripResponse, transfer?: Transferable[]): void;
};

/**
 * Decodes only a recording's keyframes, each on its own and so cheaply, and
 * sends each as a small bitmap as soon as it is made. A recording that cannot
 * be decoded here simply gets no filmstrip.
 */
async function read({ mediaUrl, height }: FilmstripRequest): Promise<void> {
  const source = await openOrderedFrameSource(mediaUrl).catch(() => undefined);
  if (source === undefined) {
    return;
  }
  try {
    let context: OffscreenCanvasRenderingContext2D | null = null;
    for (const timeUs of filmstripTimes(source.keyframeTimesUs())) {
      const frame = await source.frameAt(timeUs);
      const width = Math.max(1, Math.round((height * frame.displayWidth) / frame.displayHeight));
      context ??= new OffscreenCanvas(width, height).getContext('2d', { alpha: false });
      if (context === null) {
        frame.close();
        return;
      }
      context.drawImage(frame, 0, 0, width, height);
      frame.close();
      const pixels = context.getImageData(0, 0, width, height).data.buffer;
      scope.postMessage({ type: 'frame', timeUs, width, height, pixels }, [pixels]);
    }
  } catch {
    // What was sent stays; the rest of the strip shows the pictures before it.
  } finally {
    source.close();
  }
}

scope.addEventListener('message', (event) => {
  void read(event.data).finally(() => scope.postMessage({ type: 'done' }));
});
