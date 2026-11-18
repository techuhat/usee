import type { CameraRotation } from './camera';
import type { CameraView } from './camera-view';

/** A projective transform of normalized points: a 3×3 matrix, row by row. */
export type Homography = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** The lens a view has unless it says otherwise: a 30° vertical field of view. */
export const DEFAULT_LENS_DEGREES = 30;

const RADIANS = Math.PI / 180;

/**
 * How far the camera stands from the picture, in picture heights, for a lens
 * with a vertical field of view of `lens` degrees: a wider lens stands closer,
 * so a turn looks deeper. It moves closer as it zooms in, so a turn looks
 * equally deep at any scale.
 */
function lensDistance(lens: number | undefined): number {
  return 0.5 / Math.tan(((lens ?? DEFAULT_LENS_DEGREES) * RADIANS) / 2);
}

type Axis = readonly [number, number, number];

/** Whether the view shows the picture flat, as a plain crop. */
export function isFlatView(view: CameraView): boolean {
  const { rotation } = view;
  return rotation === undefined || (rotation.x === 0 && rotation.y === 0 && rotation.z === 0);
}

export function applyHomography(
  matrix: Homography,
  x: number,
  y: number,
): { readonly x: number; readonly y: number } {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const w = g * x + h * y + i;
  return { x: (a * x + b * y + c) / w, y: (d * x + e * y + f) / w };
}

function invert(matrix: Homography): Homography {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const first = e * i - f * h;
  const second = f * g - d * i;
  const third = d * h - e * g;
  const det = a * first + b * second + c * third;
  return [
    first / det,
    (c * h - b * i) / det,
    (b * f - c * e) / det,
    second / det,
    (a * i - c * g) / det,
    (c * d - a * f) / det,
    third / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det,
  ];
}

/**
 * Where the picture's own x and y axes point once it is turned, x right, y
 * down and z away from the camera: the rotation Rx·Ry·Rz, signed as
 * CameraRotation says.
 */
function turnedAxes(rotation: CameraRotation | undefined): { x: Axis; y: Axis } {
  const a = -(rotation?.x ?? 0) * RADIANS;
  const b = -(rotation?.y ?? 0) * RADIANS;
  const c = (rotation?.z ?? 0) * RADIANS;
  const [ca, sa, cb, sb, cc, sc] = [
    Math.cos(a),
    Math.sin(a),
    Math.cos(b),
    Math.sin(b),
    Math.cos(c),
    Math.sin(c),
  ];
  return {
    x: [cb * cc, ca * sc + sa * sb * cc, sa * sc - ca * sb * cc],
    y: [-cb * sc, ca * cc - sa * sb * sc, sa * cc + ca * sb * sc],
  };
}

/**
 * The transform of a view as it is: a source point, from the view's centre
 * in picture heights, turned with the picture, seen by a camera `distance /
 * scale` picture heights away, then back to normalized output coordinates.
 */
function project(
  view: CameraView,
  aspect: number,
  axes: { readonly x: Axis; readonly y: Axis },
  distance: number,
): Homography {
  const { scale, centerX, centerY } = view;
  // The turned point's x, y and depth, each a linear form of (u, v, 1).
  const form = (axis: 0 | 1 | 2): Axis => {
    const alongX = axes.x[axis] * aspect;
    const alongY = axes.y[axis];
    return [alongX, alongY, -(alongX * centerX + alongY * centerY)];
  };
  const [px, py, depth] = [form(0), form(1), form(2)];
  const near = scale / distance;
  const w: Axis = [near * depth[0], near * depth[1], 1 + near * depth[2]];
  const across = scale / aspect;
  return [
    across * px[0] + 0.5 * w[0],
    across * px[1] + 0.5 * w[1],
    across * px[2] + 0.5 * w[2],
    scale * py[0] + 0.5 * w[0],
    scale * py[1] + 0.5 * w[1],
    scale * py[2] + 0.5 * w[2],
    w[0],
    w[1],
    w[2],
  ];
}

/**
 * A view compiled for drawing as a card (Phase 6, docs/rendering-pipeline.md):
 * the flat crop the camera shows fills a card the size of the picture's place
 * on the canvas; the card is turned about its centre and seen through the
 * view's lens, and a pull-out (a scale under 1) shrinks it about its centre.
 * Where the card does not cover its place, the canvas shows.
 */
export interface CardTransform {
  /** What the card shows: the view's centre at its scale, at least the whole frame, flat. */
  readonly crop: CameraView;
  /** A card point (0-1 across it) to where it shows, 0-1 being the picture's place at rest. */
  readonly toOutput: Homography;
  /** A point of the picture's place to the card point it shows. */
  readonly toSource: Homography;
}

/** Whether a view draws as a plain crop filling the picture's place: flat, and not pulled out. */
export function isCropView(view: CameraView): boolean {
  return isFlatView(view) && view.scale >= 1;
}

/**
 * Compiles a view as a card on a picture of `aspect` (width over height). The
 * crop keeps the view's centre and its scale from 1 up; the card is the
 * view's turn about the card's centre, from a camera as far as its lens says,
 * shrunk by a scale under 1.
 */
export function cardTransform(view: CameraView, aspect: number): CardTransform {
  const crop: CameraView =
    view.scale >= 1
      ? { scale: view.scale, centerX: view.centerX, centerY: view.centerY }
      : { scale: 1, centerX: 0.5, centerY: 0.5 };
  const toOutput = project(
    { scale: Math.min(1, view.scale), centerX: 0.5, centerY: 0.5 },
    aspect,
    turnedAxes(view.rotation),
    lensDistance(view.lens),
  );
  return { crop, toOutput, toSource: invert(toOutput) };
}
