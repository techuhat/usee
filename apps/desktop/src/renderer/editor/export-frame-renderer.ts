import type {
  DesktopBridge,
  ExportFrameContextDto,
  ExportFrameRequestDto,
  JobId,
} from '@usee/contracts';

import { decodePointerTrack } from './project-store';
import { describeVideoFrame } from './export-render-model';

interface RenderWorkerResponse {
  readonly requestId: string;
  readonly frame: ArrayBuffer | null;
  /** The worker cannot decode this recording in order: seek a video element for it. */
  readonly needsSource?: true;
}

interface RenderSession {
  readonly context: Pick<ExportFrameContextDto, 'plan' | 'mediaUrls'>;
  readonly worker: Worker;
  readonly videos: Map<string, HTMLVideoElement>;
  readonly pending: Map<string, (response: RenderWorkerResponse) => void>;
  readonly abort: AbortController;
  /** Recordings the worker could not decode in order: their pictures come from seeking. */
  readonly sought: Set<string>;
  /**
   * Main asks for a frame or two ahead, but a video seeks one frame at a
   * time: each request's seek waits for the one before it.
   */
  seeking: Promise<unknown>;
}

function waitForVideoEvent(
  video: HTMLVideoElement,
  eventName: 'loadedmetadata' | 'loadeddata' | 'seeked',
  signal: AbortSignal,
): Promise<void> {
  if (eventName === 'loadedmetadata' && video.readyState >= HTMLMediaElement.HAVE_METADATA) {
    return Promise.resolve();
  }
  if (eventName === 'loadeddata' && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new Error('Video decoding timed out.')), 20_000);
    const finish = (cause?: Error) => {
      window.clearTimeout(timeout);
      video.removeEventListener(eventName, onReady);
      video.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
      if (cause === undefined) {
        resolve();
      } else {
        reject(cause);
      }
    };
    const onReady = () => finish();
    const onError = () => finish(new Error('The source video could not be decoded.'));
    const onAbort = () => finish(new Error('Export was canceled.'));
    video.addEventListener(eventName, onReady, { once: true });
    video.addEventListener('error', onError, { once: true });
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function videoFrame(
  session: RenderSession,
  request: ExportFrameRequestDto,
): Promise<ImageBitmap | null> {
  const descriptor = describeVideoFrame(session.context.plan, request.timelineUs);
  if (descriptor === undefined) {
    return null;
  }
  const { asset, sourceUs } = descriptor;
  const mediaUrl = session.context.mediaUrls[asset.id];
  if (mediaUrl === undefined) {
    throw new Error('The source video is missing.');
  }
  let video = session.videos.get(asset.id);
  if (video === undefined) {
    video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    video.src = mediaUrl;
    session.videos.set(asset.id, video);
    video.load();
  }
  await waitForVideoEvent(video, 'loadedmetadata', session.abort.signal);
  const seconds = sourceUs / 1_000_000;
  const currentTimeMatches = Math.abs(video.currentTime - seconds) <= 0.000_5;
  if (currentTimeMatches && video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    await waitForVideoEvent(video, 'loadeddata', session.abort.signal);
  } else if (!currentTimeMatches) {
    const seeked = waitForVideoEvent(video, 'seeked', session.abort.signal);
    video.currentTime = seconds;
    await seeked;
  }
  return createImageBitmap(video);
}

function dispose(session: RenderSession): void {
  session.abort.abort();
  session.worker.terminate();
  for (const video of session.videos.values()) {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
  for (const [requestId, resolve] of session.pending) {
    resolve({ requestId, frame: null });
  }
  session.pending.clear();
}

/** The source picture for each request, one seek at a time, in the order main asked. */
function frameInOrder(
  session: RenderSession,
  request: ExportFrameRequestDto,
): Promise<ImageBitmap | null> {
  const next = session.seeking.then(() => videoFrame(session, request));
  session.seeking = next.catch(() => undefined);
  return next;
}

/** Services main's frame requests without seeking the preview video or blocking its UI. */
export function startExportFrameRenderer(bridge: DesktopBridge): () => void {
  // A promise, so the requests main sends together share one session.
  const sessions = new Map<string, Promise<RenderSession | undefined>>();

  function sessionFor(exportJobId: JobId): Promise<RenderSession | undefined> {
    let session = sessions.get(exportJobId);
    if (session === undefined) {
      session = openSession(exportJobId);
      sessions.set(exportJobId, session);
    }
    return session;
  }

  async function openSession(exportJobId: JobId): Promise<RenderSession | undefined> {
    const loaded = await bridge.getExportFrameContext({ exportJobId });
    if (!loaded.ok) {
      return undefined;
    }
    const pointerTracks = Object.fromEntries(
      Object.entries(loaded.value.pointerTracks).map(([streamId, dto]) => [
        streamId,
        dto === null ? null : decodePointerTrack(dto),
      ]),
    );
    const context = { plan: loaded.value.plan, mediaUrls: loaded.value.mediaUrls };
    const worker = new Worker(new URL('./export-frame-worker.ts', import.meta.url), {
      type: 'module',
    });
    const session: RenderSession = {
      context,
      worker,
      videos: new Map(),
      pending: new Map(),
      abort: new AbortController(),
      sought: new Set(),
      seeking: Promise.resolve(),
    };
    worker.onmessage = ({ data }: MessageEvent<RenderWorkerResponse>) => {
      session.pending.get(data.requestId)?.(data);
      session.pending.delete(data.requestId);
    };
    worker.onerror = () => {
      for (const [requestId, resolve] of session.pending) {
        resolve({ requestId, frame: null });
      }
      session.pending.clear();
    };
    const transfer = Object.values(pointerTracks).flatMap((track) =>
      track === null ? [] : [track.moveTimes.buffer, track.moveXs.buffer, track.moveYs.buffer],
    );
    worker.postMessage({ type: 'initialize', context: { ...context, pointerTracks } }, transfer);
    return session;
  }

  const unsubscribeFrames = bridge.onExportFrameRequested((request) => {
    void (async () => {
      const session = await sessionFor(request.exportJobId);
      if (session === undefined) {
        await bridge.submitExportFrame({
          exportJobId: request.exportJobId,
          requestId: request.requestId,
          frame: null,
        });
        return;
      }
      try {
        const render = (source: ImageBitmap | null | 'decode') => {
          const result = new Promise<RenderWorkerResponse>((resolve) => {
            session.pending.set(request.requestId, resolve);
          });
          session.worker.postMessage(
            {
              type: 'render',
              requestId: request.requestId,
              timelineUs: request.timelineUs,
              source,
            },
            source instanceof ImageBitmap ? [source] : [],
          );
          return result;
        };
        // The worker decodes the recording itself, in order; a recording it
        // cannot decode is sought in a video element, from then on.
        const assetId = describeVideoFrame(session.context.plan, request.timelineUs)?.asset.id;
        let response =
          assetId === undefined || session.sought.has(assetId) ? undefined : await render('decode');
        if (response?.needsSource === true && assetId !== undefined) {
          session.sought.add(assetId);
          response = undefined;
        }
        response ??= await render(await frameInOrder(session, request));
        const buffer = response.frame;
        await bridge.submitExportFrame({
          exportJobId: request.exportJobId,
          requestId: request.requestId,
          frame: buffer === null ? null : new Uint8Array(buffer),
        });
      } catch {
        await bridge.submitExportFrame({
          exportJobId: request.exportJobId,
          requestId: request.requestId,
          frame: null,
        });
      }
    })();
  });

  const unsubscribeQueue = bridge.onExportQueueChanged((update) => {
    const state = update.job.state;
    if (state !== 'succeeded' && state !== 'failed' && state !== 'canceled') {
      return;
    }
    const session = sessions.get(update.job.exportJobId);
    if (session !== undefined) {
      sessions.delete(update.job.exportJobId);
      void session.then((opened) => opened !== undefined && dispose(opened));
    }
  });

  void bridge.getExportQueue();
  return () => {
    unsubscribeFrames();
    unsubscribeQueue();
    for (const session of sessions.values()) {
      void session.then((opened) => opened !== undefined && dispose(opened));
    }
    sessions.clear();
  };
}
