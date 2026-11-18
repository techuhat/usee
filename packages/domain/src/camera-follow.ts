import { clampView, type CameraView } from './camera-view';
import { cursorPositionAt, type CursorPath } from './cursor-path';
import { turnShift } from './focus';

/**
 * How widely the camera averages the pointer it follows: the standard
 * deviation of Gaussian weights that reach as far ahead in time as behind,
 * so the camera glides along a steady move without trailing it.
 */
export const FOLLOW_SIGMA_US = 250_000;
const FOLLOW_STEP_US = 25_000;
const FOLLOW_REACH = Math.round((3 * FOLLOW_SIGMA_US) / FOLLOW_STEP_US);
const FOLLOW_WEIGHTS = Array.from({ length: 2 * FOLLOW_REACH + 1 }, (_, index) => {
  const offsetUs = (index - FOLLOW_REACH) * FOLLOW_STEP_US;
  return Math.exp(-(offsetUs * offsetUs) / (2 * FOLLOW_SIGMA_US * FOLLOW_SIGMA_US));
});
const FOLLOW_TOTAL = FOLLOW_WEIGHTS.reduce((sum, weight) => sum + weight, 0);

/**
 * How far from the view's centre the followed pointer may stray before the
 * camera moves, as a share of the view's half-size: the outer fifth of the
 * view on each side is kept clear of it.
 */
export const FOLLOW_KEEP = 0.6;

/** The pointer averaged over the moments around `sessionUs`, as the camera follows it. */
function followedPoint(path: CursorPath, sessionUs: number): { x: number; y: number } | undefined {
  let x = 0;
  let y = 0;
  for (const [index, weight] of FOLLOW_WEIGHTS.entries()) {
    const position = cursorPositionAt(path, sessionUs + (index - FOLLOW_REACH) * FOLLOW_STEP_US);
    if (position === undefined) {
      return undefined;
    }
    x += weight * position.x;
    y += weight * position.y;
  }
  return { x: x / FOLLOW_TOTAL, y: y / FOLLOW_TOTAL };
}

/**
 * The generated camera's view, moved just enough to keep the pointer in it.
 * Where the pointer, averaged over the moments around (FOLLOW_SIGMA_US),
 * strays further from the centre than FOLLOW_KEEP of the view's half-size,
 * the view moves along with it, inside the frame, so a pointer that leaves
 * the place the camera planned for stays in the picture. A view of the whole
 * frame has nothing to follow. A view turned in 3D turns toward where it now
 * looks as far as `turn3d` turns the planned camera toward its own (turnShift).
 */
export function followPointer(
  view: CameraView,
  path: CursorPath,
  sessionUs: number,
  turn3d = 0,
): CameraView {
  if (view.scale <= 1) {
    return view;
  }
  const point = followedPoint(path, sessionUs);
  if (point === undefined) {
    return view;
  }
  const reach = (0.5 / view.scale) * FOLLOW_KEEP;
  const beyond = (offset: number) =>
    offset > reach ? offset - reach : offset < -reach ? offset + reach : 0;
  const dx = beyond(point.x - view.centerX);
  const dy = beyond(point.y - view.centerY);
  if (dx === 0 && dy === 0) {
    return view;
  }
  const moved = clampView({ ...view, centerX: view.centerX + dx, centerY: view.centerY + dy });
  if (view.rotation === undefined || !(turn3d > 0)) {
    return moved;
  }
  const turn = turnShift(moved.centerX - view.centerX, moved.centerY - view.centerY, turn3d);
  return {
    ...moved,
    rotation: {
      x: view.rotation.x + turn.x,
      y: view.rotation.y + turn.y,
      z: view.rotation.z,
    },
  };
}
