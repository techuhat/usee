import type { AssetId, ExportFrameContextDto, RenderPlanDto } from '@usee/contracts';
import {
  composeFrame,
  deriveCursorPath,
  exportDimensions,
  generatedZoomEffects,
  pointerTimeOrigin,
  isCropView,
  type CursorPath,
  type Effect,
  type PointerTrack,
} from '@usee/domain';

import { CameraProjector } from './camera-projection';
import { clipToPicture, drawFrame, paintCanvas, paintShadow, tracePicture } from './compositor';
import { describeVideoFrame, firstVideoAsset } from './export-render-model';
import { openOrderedFrameSource, type OrderedFrameSource } from './export-video-decoder';

interface RenderContext {
  readonly plan: RenderPlanDto;
  readonly mediaUrls: ExportFrameContextDto['mediaUrls'];
  readonly pointerTracks: Readonly<Record<string, PointerTrack | null>>;
}

type Request =
  | { readonly type: 'initialize'; readonly context: RenderContext }
  | {
      readonly type: 'render';
      readonly requestId: string;
      readonly timelineUs: number;
      /**
       * `decode`: the worker decodes the source picture itself; a bitmap: the
       * picture a video element sought to; null: no picture at this time.
       */
      readonly source: ImageBitmap | null | 'decode';
    };

interface Response {
  readonly requestId: string;
  readonly frame: ArrayBuffer | null;
  /** The worker cannot decode this recording: seek a video element and send the picture. */
  readonly needsSource?: true;
}

const scope = self as unknown as {
  addEventListener(type: 'message', listener: (event: MessageEvent<Request>) => void): void;
  postMessage(message: Response, transfer?: Transferable[]): void;
};
let renderContext: RenderContext | undefined;
let canvas: OffscreenCanvas | undefined;
let context: OffscreenCanvasRenderingContext2D | null = null;
let projector: CameraProjector | undefined;
const paths = new Map<string, CursorPath>();
const autoZooms = new Map<string, readonly Effect[]>();
/** Each recording's decoder, opened on first use; undefined when it cannot decode in order. */
const decoders = new Map<string, Promise<OrderedFrameSource | undefined>>();
/** Renders run one at a time, in the order main asked for them. */
let queue: Promise<void> = Promise.resolve();

function decoderFor(assetId: AssetId): Promise<OrderedFrameSource | undefined> {
  let decoder = decoders.get(assetId);
  if (decoder === undefined) {
    const url = renderContext?.mediaUrls[assetId];
    decoder =
      url === undefined
        ? Promise.resolve(undefined)
        : openOrderedFrameSource(url).catch(() => undefined);
    decoders.set(assetId, decoder);
  }
  return decoder;
}

/** The decoded picture at `sourceUs`, or undefined when a video element must find it instead. */
async function decodedFrame(assetId: AssetId, sourceUs: number): Promise<VideoFrame | undefined> {
  const decoder = await decoderFor(assetId);
  if (decoder === undefined) {
    return undefined;
  }
  try {
    return await decoder.frameAt(sourceUs);
  } catch {
    // One failure and this recording is sought from then on.
    decoder.close();
    decoders.set(assetId, Promise.resolve(undefined));
    return undefined;
  }
}

function initialize(next: RenderContext): void {
  renderContext = next;
  for (const [streamId, track] of Object.entries(next.pointerTracks)) {
    if (track !== null) {
      paths.set(streamId, deriveCursorPath(track, next.plan.cursor.smoothing));
    }
  }
  for (const track of next.plan.tracks) {
    for (const clip of track.clips) {
      if (clip.pointer === null || autoZooms.has(clip.assetId) || !next.plan.autoZoom.enabled) {
        continue;
      }
      const run = next.plan.analysisRuns.find(
        (candidate) =>
          candidate.kind === 'camera-track' && candidate.sessionId === clip.pointer?.sessionId,
      );
      const effects =
        run === undefined
          ? []
          : generatedZoomEffects(
              run.zooms,
              pointerTimeOrigin(clip.pointer),
              next.plan.autoZoom.scale,
              next.plan.autoZoom.turn3d,
            );
      autoZooms.set(
        clip.assetId,
        effects.filter((effect) => !next.plan.autoZoom.disabled.includes(effect.id)),
      );
    }
  }
  const source = firstVideoAsset(next.plan);
  if (source === undefined) {
    throw new Error('The render plan has no video source.');
  }
  const size = exportDimensions(
    next.plan.preset,
    next.plan.canvas,
    source.dimensions.width / source.dimensions.height,
  );
  canvas = new OffscreenCanvas(size.width, size.height);
  context = canvas.getContext('2d', { alpha: false });
  if (context === null) {
    throw new Error('The renderer could not create an export canvas.');
  }
  projector = new CameraProjector(() => new OffscreenCanvas(1, 1));
}

async function render(request: Extract<Request, { readonly type: 'render' }>): Promise<void> {
  const configuration = renderContext;
  const target = canvas;
  const drawing = context;
  const cameraProjector = projector;
  if (
    configuration === undefined ||
    target === undefined ||
    drawing === null ||
    cameraProjector === undefined
  ) {
    throw new Error('The export renderer is not initialized.');
  }
  const descriptor = describeVideoFrame(configuration.plan, request.timelineUs);
  let decoded: VideoFrame | undefined;
  if (descriptor !== undefined && request.source === 'decode') {
    decoded = await decodedFrame(descriptor.asset.id, descriptor.sourceUs);
    if (decoded === undefined) {
      scope.postMessage({ requestId: request.requestId, frame: null, needsSource: true });
      return;
    }
  }
  const source = decoded ?? (request.source === 'decode' ? null : request.source);
  if (descriptor === undefined || source === null) {
    paintCanvas(drawing, configuration.plan.canvas, { width: 1, height: 1 });
  } else {
    const { clip, asset, sourceUs } = descriptor;
    const pointer = clip.pointer;
    const path = pointer === null ? undefined : paths.get(pointer.streamAssetId);
    const frame = composeFrame(
      clip.effects,
      sourceUs,
      pointer === null || path === undefined
        ? undefined
        : {
            path,
            sessionStartUs: pointerTimeOrigin(pointer),
            settings: configuration.plan.cursor,
          },
      autoZooms.get(asset.id),
      configuration.plan.autoZoom.turn3d ?? 0,
    );
    const sourceSize = asset.dimensions;
    const place = paintCanvas(drawing, configuration.plan.canvas, sourceSize, source);
    const motionBlur = configuration.plan.canvas.motionBlur ?? 0;
    if (isCropView(frame.camera)) {
      paintShadow(drawing, configuration.plan.canvas, () => tracePicture(drawing, place));
      drawing.save();
      clipToPicture(drawing, place);
      drawFrame(drawing, source, sourceSize, frame, place, motionBlur);
      drawing.restore();
    } else {
      cameraProjector.draw(
        drawing,
        source,
        sourceSize,
        frame,
        place,
        configuration.plan.canvas,
        motionBlur,
      );
    }
  }
  decoded?.close();
  // Raw RGBA, the canvas's own pixels: encoding a PNG here took as long as everything else.
  const frame = drawing.getImageData(0, 0, target.width, target.height).data.buffer;
  scope.postMessage({ requestId: request.requestId, frame } satisfies Response, [frame]);
}

function closeSource(request: Extract<Request, { readonly type: 'render' }>): void {
  if (request.source instanceof ImageBitmap) {
    request.source.close();
  }
}

scope.addEventListener('message', (event: MessageEvent<Request>) => {
  const request = event.data;
  if (request.type === 'initialize') {
    try {
      initialize(request.context);
    } catch {
      renderContext = undefined;
    }
    return;
  }
  queue = queue
    .then(() => render(request).finally(() => closeSource(request)))
    .catch(() => {
      scope.postMessage({ requestId: request.requestId, frame: null } satisfies Response);
    });
});
