import { asTimestampUs } from '@usee/contracts';

import type { CameraRotation, ZoomKeyframe } from './camera';
import type { ZoomEffect } from './effects';

/**
 * Built-in 3D moves for a zoom (Phase 6): pushing in from a tilted, wider
 * view; pulling back out to a floating, turned card; tilting up; swinging
 * across; orbiting around the point looked at.
 */
export type CameraPreset = 'push-in' | 'pull-out' | 'tilt-up' | 'swing' | 'orbit';

export const CAMERA_PRESETS: readonly CameraPreset[] = Object.freeze([
  'push-in',
  'pull-out',
  'tilt-up',
  'swing',
  'orbit',
]);

/** A keyframe's place in the move (0 its start, 1 its end), scale and turn. */
interface Step {
  readonly at: number;
  readonly scale: number;
  readonly rotation?: CameraRotation;
}

/** How far a pull-out draws back: the picture at four fifths of its place. */
const PULLED_OUT = 0.8;

function steps(preset: CameraPreset, scale: number): readonly Step[] {
  switch (preset) {
    case 'push-in':
      return [
        { at: 0, scale: Math.max(1, scale / 1.6), rotation: { x: 10, y: 0, z: 0 } },
        { at: 1, scale },
      ];
    case 'pull-out':
      return [
        { at: 0, scale },
        { at: 1, scale: PULLED_OUT, rotation: { x: 8, y: -12, z: 0 } },
      ];
    case 'tilt-up':
      return [
        { at: 0, scale, rotation: { x: 16, y: 0, z: 0 } },
        { at: 1, scale },
      ];
    case 'swing':
      return [
        { at: 0, scale, rotation: { x: 4, y: -18, z: 0 } },
        { at: 1, scale, rotation: { x: 4, y: 18, z: 0 } },
      ];
    case 'orbit':
      return [
        { at: 0, scale, rotation: { x: 8, y: -20, z: -2 } },
        { at: 0.5, scale, rotation: { x: 14, y: 0, z: 0 } },
        { at: 1, scale, rotation: { x: 8, y: 20, z: 2 } },
      ];
  }
}

/**
 * A zoom's keyframes for a built-in 3D move: spread over its body, between
 * its ramps (its whole span when they leave too little), looking where its
 * first pose looks and as close as it is (1.5× when it pulls back). The
 * first and last keyframes stop; one between them flows.
 */
export function presetKeyframes(zoom: ZoomEffect, preset: CameraPreset): ZoomKeyframe[] {
  const first = zoom.poses[0]?.value;
  const anchor = first?.anchor ?? { x: 0.5, y: 0.5 };
  const scale = first === undefined || first.scale < 1 ? 1.5 : first.scale;
  const start = zoom.range.startUs;
  const end = start + zoom.range.durationUs;
  const bodyStart = start + zoom.easeInUs;
  const bodyEnd = end - zoom.easeOutUs;
  const [from, to] = bodyEnd - bodyStart >= 200_000 ? [bodyStart, bodyEnd] : [start, end];
  return steps(preset, scale).map((step) => ({
    timestampUs: asTimestampUs(Math.round(from + step.at * (to - from))),
    value: {
      anchor,
      scale: step.scale,
      ...(step.rotation === undefined ? {} : { rotation: step.rotation }),
    },
    easing: 'ease-in-out',
  }));
}
