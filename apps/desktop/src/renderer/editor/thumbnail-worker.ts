import { openOrderedFrameSource } from './export-video-decoder';

/** The thumbnail's size: the list's tile at twice its pixels, 16:9. */
export const THUMBNAIL_SIZE = Object.freeze({ width: 320, height: 180 });

export interface ThumbnailRequest {
  readonly mediaUrl: string;
  /** Where in the recording to take the picture from. */
  readonly atUs: number;
}

/** A small JPEG of the recording at `atUs`, or null when it cannot be decoded here. */
export type ThumbnailResponse = { readonly jpeg: ArrayBuffer | null };

const scope = self as unknown as {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<ThumbnailRequest>) => void,
  ): void;
  postMessage(message: ThumbnailResponse, transfer?: Transferable[]): void;
};

async function thumbnail({ mediaUrl, atUs }: ThumbnailRequest): Promise<ArrayBuffer | null> {
  const source = await openOrderedFrameSource(mediaUrl).catch(() => undefined);
  if (source === undefined) {
    return null;
  }
  try {
    const frame = await source.frameAt(atUs);
    const { width, height } = THUMBNAIL_SIZE;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { alpha: false });
    if (context === null) {
      frame.close();
      return null;
    }
    // The whole picture, letterboxed on the app's own dark.
    context.fillStyle = '#12162a';
    context.fillRect(0, 0, width, height);
    const scale = Math.min(width / frame.displayWidth, height / frame.displayHeight);
    const drawn = { w: frame.displayWidth * scale, h: frame.displayHeight * scale };
    context.drawImage(frame, (width - drawn.w) / 2, (height - drawn.h) / 2, drawn.w, drawn.h);
    frame.close();
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
    return await blob.arrayBuffer();
  } catch {
    return null;
  } finally {
    source.close();
  }
}

scope.addEventListener('message', (event) => {
  void thumbnail(event.data).then((jpeg) =>
    scope.postMessage({ jpeg }, jpeg === null ? [] : [jpeg]),
  );
});
