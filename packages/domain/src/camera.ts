import type { Point } from '@usee/contracts';

import type { Keyframe } from './keyframes';

/**
 * How the picture is turned in 3D about the point the camera looks at, in
 * degrees: Euler angles applied in one fixed order (z, then y, then x) and
 * kept within MAX_CAMERA_TURN_DEGREES, so they interpolate one by one
 * without gimbal lock.
 */
export interface CameraRotation {
  /** About the horizontal axis: positive moves the top edge away. */
  readonly x: number;
  /** About the vertical axis: positive moves the right edge away. */
  readonly y: number;
  /** About the view axis: positive turns the picture clockwise. */
  readonly z: number;
}

/**
 * A camera pose: the point it looks at (`anchor`, normalized), how close it
 * is (`scale`, 1 the whole frame), and how the picture is turned, flat when
 * `rotation` is absent. A zoom's keyframes are camera poses, not a second,
 * competing transform system (docs/module-boundaries.md, "3D camera seam").
 */
export interface CameraPose {
  readonly anchor: Point;
  readonly scale: number;
  readonly rotation?: CameraRotation;
}

export type CameraKeyframe = Keyframe<CameraPose>;

export type ZoomPose = CameraPose;

/**
 * A zoom's keyframe. The camera flows through a keyframe on one smooth path,
 * unless it holds there: then it stops, and the move to the next keyframe
 * eases as that keyframe's easing says (every keyframe held before
 * manifest v9).
 */
export interface ZoomKeyframe extends Keyframe<ZoomPose> {
  readonly hold?: boolean;
}
