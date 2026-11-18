import type { CameraRotation, ZoomKeyframe, ZoomPose } from './camera';
import { DEFAULT_LENS_DEGREES } from './camera-transform';
import { ease, lerp } from './easing';
import type { Effect, ZoomEffect } from './effects';

/**
 * The part of the source frame the output shows: centred on (`centerX`,
 * `centerY`), `1 / scale` of the frame wide and high, always inside it.
 * Normalized coordinates; `scale` 1 is the whole frame, and under 1 the
 * camera pulls back from it. A view with a `rotation` shows the picture
 * turned in 3D, as a card over the canvas (cardTransform), seen through a
 * lens with a vertical field of view of `lens` degrees (30 when absent).
 */
export interface CameraView {
  readonly scale: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly rotation?: CameraRotation;
  readonly lens?: number;
}

export const FULL_FRAME: CameraView = Object.freeze({ scale: 1, centerX: 0.5, centerY: 0.5 });

/**
 * Keeps a view inside the frame by moving its centre, never by changing its
 * size. A view pulled back (scale up to 1) shows the whole frame, centred.
 */
export function clampView(view: CameraView): CameraView {
  if (view.scale <= 1) {
    return { ...view, centerX: 0.5, centerY: 0.5 };
  }
  const half = 0.5 / view.scale;
  return {
    ...view,
    centerX: Math.min(1 - half, Math.max(half, view.centerX)),
    centerY: Math.min(1 - half, Math.max(half, view.centerY)),
  };
}

/** How far into its pose a zoom is at `sourceUs`: 0 outside it, 1 while holding. */
export function zoomProgress(zoom: ZoomEffect, sourceUs: number): number {
  const start = zoom.range.startUs;
  const end = start + zoom.range.durationUs;
  if (sourceUs < start || sourceUs >= end) {
    return 0;
  }
  if (zoom.easeInUs > 0 && sourceUs < start + zoom.easeInUs) {
    return ease(zoom.easing, (sourceUs - start) / zoom.easeInUs);
  }
  if (zoom.easeOutUs > 0 && sourceUs > end - zoom.easeOutUs) {
    return ease(zoom.easing, (end - sourceUs) / zoom.easeOutUs);
  }
  return 1;
}

/** A pose as a view, kept inside the frame. */
function poseView(pose: ZoomPose): CameraView {
  const view = { scale: pose.scale, centerX: pose.anchor.x, centerY: pose.anchor.y };
  return clampView(pose.rotation === undefined ? view : { ...view, rotation: pose.rotation });
}

/** The turn `progress` of the way from one to the other; flat when neither turns. */
function blendRotations(
  from: CameraRotation | undefined,
  to: CameraRotation | undefined,
  progress: number,
): CameraRotation | undefined {
  if (from === undefined && to === undefined) {
    return undefined;
  }
  return {
    x: lerp(from?.x ?? 0, to?.x ?? 0, progress),
    y: lerp(from?.y ?? 0, to?.y ?? 0, progress),
    z: lerp(from?.z ?? 0, to?.z ?? 0, progress),
  };
}

/** The lens `progress` of the way from one view's to the other's; absent when neither has one. */
function blendLenses(from: CameraView, to: CameraView, progress: number): number | undefined {
  if (from.lens === undefined && to.lens === undefined) {
    return undefined;
  }
  return lerp(from.lens ?? DEFAULT_LENS_DEGREES, to.lens ?? DEFAULT_LENS_DEGREES, progress);
}

/**
 * The view `progress` of the way from `from` to `to`. The scale moves in log
 * space, so a zoom feels even, and the centre follows the scale, so the
 * target stays still on screen as the view closes in on it; the turn and the
 * lens move evenly.
 */
function blendViews(from: CameraView, to: CameraView, progress: number): CameraView {
  if (progress <= 0) {
    return from;
  }
  if (progress >= 1) {
    return to;
  }
  const scale = Math.exp(lerp(Math.log(from.scale), Math.log(to.scale), progress));
  const along = to.scale === from.scale ? progress : (scale - from.scale) / (to.scale - from.scale);
  const view = {
    scale,
    centerX: lerp(from.centerX, to.centerX, along),
    centerY: lerp(from.centerY, to.centerY, along),
  };
  const rotation = blendRotations(from.rotation, to.rotation, progress);
  const lens = blendLenses(from, to, progress);
  return clampView({
    ...view,
    ...(rotation === undefined ? {} : { rotation }),
    ...(lens === undefined ? {} : { lens }),
  });
}

/** Whether the camera stops at keyframe `index`: it holds there, or it is the first or the last. */
function stopsAt(keyframes: readonly ZoomKeyframe[], index: number): boolean {
  return index <= 0 || index >= keyframes.length - 1 || keyframes[index]?.hold === true;
}

/** The parts of a view that move along a smooth path: log scale, centre and turn. */
type Parts = readonly number[];

function partsAt(keyframes: readonly ZoomKeyframe[], index: number): Parts {
  const keyframe = keyframes[index];
  if (keyframe === undefined) {
    return [];
  }
  const view = poseView(keyframe.value);
  const { rotation } = view;
  return [
    Math.log(view.scale),
    view.centerX,
    view.centerY,
    rotation?.x ?? 0,
    rotation?.y ?? 0,
    rotation?.z ?? 0,
  ];
}

/**
 * The slope of each part as the path passes keyframe `index`, per
 * microsecond: none where the camera stops or a part turns back, so the path
 * never overshoots a keyframe; otherwise the time-weighted mean of the slopes
 * either side, kept within three times the gentler one (a monotone cubic).
 */
function slopesAt(keyframes: readonly ZoomKeyframe[], index: number): Parts {
  const here = partsAt(keyframes, index);
  const before = keyframes[index - 1];
  const keyframe = keyframes[index];
  const after = keyframes[index + 1];
  if (
    stopsAt(keyframes, index) ||
    before === undefined ||
    keyframe === undefined ||
    after === undefined
  ) {
    return here.map(() => 0);
  }
  const into = keyframe.timestampUs - before.timestampUs;
  const out = after.timestampUs - keyframe.timestampUs;
  if (!(into > 0 && out > 0)) {
    return here.map(() => 0);
  }
  const previous = partsAt(keyframes, index - 1);
  const next = partsAt(keyframes, index + 1);
  return here.map((value, part) => {
    const incoming = (value - (previous[part] ?? value)) / into;
    const outgoing = ((next[part] ?? value) - value) / out;
    if (!(incoming * outgoing > 0)) {
      return 0;
    }
    const mean = (out * incoming + into * outgoing) / (into + out);
    const gentler = Math.min(Math.abs(incoming), Math.abs(outgoing));
    return Math.sign(mean) * Math.min(Math.abs(mean), 3 * gentler);
  });
}

/**
 * The view `progress` (0-1) of the way from keyframe `index` to the next on
 * the smooth path through them: a cubic Hermite curve of each part, leaving
 * and arriving at the slopes the path has there.
 */
function flowView(keyframes: readonly ZoomKeyframe[], index: number, progress: number): CameraView {
  const from = keyframes[index];
  const to = keyframes[index + 1];
  if (from === undefined || to === undefined) {
    return FULL_FRAME;
  }
  const span = to.timestampUs - from.timestampUs;
  const [a, b] = [partsAt(keyframes, index), partsAt(keyframes, index + 1)];
  const [leaving, arriving] = [slopesAt(keyframes, index), slopesAt(keyframes, index + 1)];
  const s = progress;
  const [h00, h10, h01, h11] = [
    2 * s ** 3 - 3 * s ** 2 + 1,
    s ** 3 - 2 * s ** 2 + s,
    -2 * s ** 3 + 3 * s ** 2,
    s ** 3 - s ** 2,
  ];
  const part = (which: number) =>
    h00 * (a[which] ?? 0) +
    h10 * span * (leaving[which] ?? 0) +
    h01 * (b[which] ?? 0) +
    h11 * span * (arriving[which] ?? 0);
  const view = { scale: Math.exp(part(0)), centerX: part(1), centerY: part(2) };
  const turned = from.value.rotation !== undefined || to.value.rotation !== undefined;
  return clampView(turned ? { ...view, rotation: { x: part(3), y: part(4), z: part(5) } } : view);
}

/**
 * Where a zoom looks at `sourceUs`, ramps aside: its pose there. The camera
 * flows through its keyframes on one smooth path and stops only where one
 * holds, and at the first and the last; between two stops it moves as a ramp
 * does, shaped by the earlier keyframe's easing. Before the first keyframe
 * and after the last it holds them.
 */
export function zoomViewAt(zoom: ZoomEffect, sourceUs: number): CameraView {
  const view = poseViewAt(zoom.poses, sourceUs);
  return zoom.lens === undefined ? view : { ...view, lens: zoom.lens };
}

/** Where a zoom's keyframes put the camera at `sourceUs` (zoomViewAt). */
function poseViewAt(keyframes: readonly ZoomKeyframe[], sourceUs: number): CameraView {
  const first = keyframes[0];
  const last = keyframes.at(-1);
  if (first === undefined || last === undefined) {
    return FULL_FRAME;
  }
  const next = keyframes.findIndex((keyframe) => keyframe.timestampUs > sourceUs);
  if (next === 0) {
    return poseView(first.value);
  }
  if (next === -1) {
    return poseView(last.value);
  }
  const from = keyframes[next - 1] ?? first;
  const to = keyframes[next] ?? last;
  const span = to.timestampUs - from.timestampUs;
  if (!(span > 0)) {
    return poseView(to.value);
  }
  const progress = (sourceUs - from.timestampUs) / span;
  if (stopsAt(keyframes, next - 1) && stopsAt(keyframes, next)) {
    return blendViews(poseView(from.value), poseView(to.value), ease(from.easing, progress));
  }
  return flowView(keyframes, next - 1, progress);
}

/** The pose that shows `view`: a keyframe added there keeps the camera where it is. */
export function viewPose(view: CameraView): ZoomPose {
  const pose = { anchor: { x: view.centerX, y: view.centerY }, scale: view.scale };
  return view.rotation === undefined ? pose : { ...pose, rotation: view.rotation };
}

/**
 * The camera at a moment of a clip's source media. Zooms apply in the order
 * they begin, each easing from the view before it to its own pose and back:
 * one that begins inside another moves the camera from that zoom's view to
 * its target and, when it ends first, back again, so the camera never jumps.
 * While held, the zoom that began last decides the view. `base` is the view
 * under them all: the whole frame, or a generated camera layer that the
 * clip's own zooms override (docs/module-boundaries.md, "Camera engine").
 */
export function cameraViewAt(
  effects: readonly Effect[],
  sourceUs: number,
  base: CameraView = FULL_FRAME,
): CameraView {
  const zooms = effects
    .filter((effect): effect is ZoomEffect => effect.kind === 'zoom' && effect.enabled)
    .filter((zoom) => zoomProgress(zoom, sourceUs) > 0)
    .sort((first, second) => first.range.startUs - second.range.startUs);
  let view = base;
  for (const zoom of zooms) {
    view = blendViews(view, zoomViewAt(zoom, sourceUs), zoomProgress(zoom, sourceUs));
  }
  return view;
}

/** Where a source point lands in the output of a flat view, both normalized. */
export function projectPoint(view: CameraView, x: number, y: number): { x: number; y: number } {
  return {
    x: (x - view.centerX) * view.scale + 0.5,
    y: (y - view.centerY) * view.scale + 0.5,
  };
}
