import type { AnnotationShape, BlurRegion, CursorSettings, Effect } from './effects';
import type { Keyframe } from './keyframes';

export const MAX_ZOOM_SCALE = 8;
/** How far a zoom pulls back: the picture at half its size. */
export const MIN_ZOOM_SCALE = 0.5;
/** A zoom's lens, as its vertical field of view in degrees. */
export const MIN_LENS_DEGREES = 15;
export const MAX_LENS_DEGREES = 60;
/** The furthest a zoom turns the picture about each axis (CameraRotation). */
export const MAX_CAMERA_TURN_DEGREES = 30;
export const MAX_BLUR_INTENSITY = 0.2;
/** An annotation's words, at most this many characters. */
export const MAX_ANNOTATION_TEXT = 120;
/** A text annotation's height, as a share of the frame's height. */
export const MIN_ANNOTATION_TEXT_SIZE = 0.02;
export const MAX_ANNOTATION_TEXT_SIZE = 0.2;
/** An arrow's or a box's line, as a share of the frame's height. */
export const MIN_ANNOTATION_LINE = 0.002;
export const MAX_ANNOTATION_LINE = 0.03;

const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

const inUnit = (value: number) => value >= 0 && value <= 1;
// Masks may reach a little past the frame, so a region can cover an edge fully.
const nearFrame = (value: number) => value >= -1 && value <= 2;

function regionProblem(region: BlurRegion): string | undefined {
  if (region.kind === 'polygon') {
    if (region.points.length < 3) {
      return 'a polygon needs at least three points';
    }
    return region.points.every((point) => nearFrame(point.x) && nearFrame(point.y))
      ? undefined
      : 'a polygon point is far outside the frame';
  }
  const { x, y, width, height } = region.bounds;
  if (!(width > 0 && height > 0)) {
    return 'a region needs a width and a height';
  }
  return [x, y, x + width, y + height].every(nearFrame)
    ? undefined
    : 'a region is far outside the frame';
}

function annotationProblem(shape: AnnotationShape): string | undefined {
  if (!HEX_COLOUR.test(shape.color)) {
    return 'the annotation colour is not a colour';
  }
  const between = (value: number, min: number, max: number) => value >= min && value <= max;
  switch (shape.kind) {
    case 'text':
      if (shape.text.trim() === '') {
        return 'a text needs words';
      }
      if (shape.text.length > MAX_ANNOTATION_TEXT) {
        return `a text is at most ${MAX_ANNOTATION_TEXT} characters`;
      }
      if (!between(shape.size, MIN_ANNOTATION_TEXT_SIZE, MAX_ANNOTATION_TEXT_SIZE)) {
        return `text size must be ${MIN_ANNOTATION_TEXT_SIZE}-${MAX_ANNOTATION_TEXT_SIZE}`;
      }
      return inUnit(shape.at.x) && inUnit(shape.at.y)
        ? undefined
        : 'an annotation must be on the frame';
    case 'arrow':
    case 'box': {
      if (!between(shape.lineWidth, MIN_ANNOTATION_LINE, MAX_ANNOTATION_LINE)) {
        return `a line must be ${MIN_ANNOTATION_LINE}-${MAX_ANNOTATION_LINE} thick`;
      }
      if (shape.kind === 'arrow') {
        if (![shape.from.x, shape.from.y, shape.to.x, shape.to.y].every(inUnit)) {
          return 'an annotation must be on the frame';
        }
        return shape.from.x === shape.to.x && shape.from.y === shape.to.y
          ? 'an arrow needs a length'
          : undefined;
      }
      const { x, y, width, height } = shape.bounds;
      if (!(width > 0 && height > 0)) {
        return 'a box needs a width and a height';
      }
      return [x, y, x + width, y + height].every(inUnit)
        ? undefined
        : 'an annotation must be on the frame';
    }
  }
}

/** Whether keyframes are in time order and inside their effect's range. */
function keyframesInside(keyframes: readonly Keyframe<unknown>[], effect: Effect): boolean {
  const start = effect.range.startUs;
  const end = start + effect.range.durationUs;
  let previous = -Infinity;
  for (const keyframe of keyframes) {
    if (
      keyframe.timestampUs < previous ||
      keyframe.timestampUs < start ||
      keyframe.timestampUs > end
    ) {
      return false;
    }
    previous = keyframe.timestampUs;
  }
  return true;
}

/** Why an effect is not valid on its own, or undefined when it is. */
export function effectProblem(effect: Effect): string | undefined {
  if (!(effect.range.durationUs > 0)) {
    return 'an effect needs a duration';
  }
  switch (effect.kind) {
    case 'zoom': {
      const { poses, easeInUs, easeOutUs } = effect;
      if (poses.length === 0) {
        return 'a zoom needs a pose';
      }
      if (!keyframesInside(poses, effect)) {
        return 'zoom keyframes must be in order, inside the zoom';
      }
      for (const { value: pose } of poses) {
        if (!(pose.scale >= MIN_ZOOM_SCALE && pose.scale <= MAX_ZOOM_SCALE)) {
          return `zoom scale must be ${MIN_ZOOM_SCALE}-${MAX_ZOOM_SCALE}`;
        }
        if (!inUnit(pose.anchor.x) || !inUnit(pose.anchor.y)) {
          return 'the zoom target must be inside the frame';
        }
        const turn = pose.rotation;
        if (
          turn !== undefined &&
          ![turn.x, turn.y, turn.z].every((angle) => Math.abs(angle) <= MAX_CAMERA_TURN_DEGREES)
        ) {
          return `a zoom turns at most ${MAX_CAMERA_TURN_DEGREES} degrees each way`;
        }
      }
      if (easeInUs < 0 || easeOutUs < 0 || easeInUs + easeOutUs > effect.range.durationUs) {
        return 'zoom ramps must fit inside the zoom';
      }
      if (
        effect.lens !== undefined &&
        !(effect.lens >= MIN_LENS_DEGREES && effect.lens <= MAX_LENS_DEGREES)
      ) {
        return `a zoom's lens is ${MIN_LENS_DEGREES}-${MAX_LENS_DEGREES} degrees`;
      }
      return undefined;
    }
    case 'blur': {
      if (!(effect.intensity > 0 && effect.intensity <= MAX_BLUR_INTENSITY)) {
        return `blur intensity must be above 0 and at most ${MAX_BLUR_INTENSITY}`;
      }
      if (effect.regions.length === 0) {
        return 'a blur needs at least one keyframe';
      }
      if (!keyframesInside(effect.regions, effect)) {
        return 'blur keyframes must be in order, inside the effect';
      }
      for (const keyframe of effect.regions) {
        if (keyframe.value.length === 0) {
          return 'a blur keyframe needs a region';
        }
        const problem = keyframe.value.map(regionProblem).find((found) => found !== undefined);
        if (problem !== undefined) {
          return problem;
        }
      }
      return undefined;
    }
    case 'annotation':
      return annotationProblem(effect.shape);
    case 'custom':
      return effect.type.trim() === '' ? 'a custom effect needs a type' : undefined;
  }
}

/** Why cursor settings are not valid, or undefined when they are. */
export function cursorSettingsProblem(settings: CursorSettings): string | undefined {
  if (!(settings.size >= 0.5 && settings.size <= 3)) {
    return 'cursor size must be 0.5-3';
  }
  if (settings.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(settings.color)) {
    return 'the cursor colour is not a colour';
  }
  if (settings.spotlight !== undefined && !inUnit(settings.spotlight)) {
    return 'the spotlight must be 0-1';
  }
  return inUnit(settings.smoothing) ? undefined : 'cursor smoothing must be 0-1';
}
