import {
  asDurationUs,
  asEffectId,
  asTimestampUs,
  type EffectDto,
  type Rectangle,
  type TimestampUs,
} from '@usee/contracts';
import {
  ANNOTATION_FADE_US,
  blurRegionsAt,
  MAX_ZOOM_SCALE,
  viewPose,
  zoomViewAt,
  type CameraRotation,
  type Easing,
} from '@usee/domain';

import { clamp, timelineTimeUs, type SnapshotClip } from './timeline-math';

export type ZoomDto = Extract<EffectDto, { kind: 'zoom' }>;
export type BlurDto = Extract<EffectDto, { kind: 'blur' }>;
type BlurRegionDto = BlurDto['regions'][number]['value'][number];
export type ZoomPoseDto = ZoomDto['poses'][number]['value'];
export type AnnotationDto = Extract<EffectDto, { kind: 'annotation' }>;
export type AnnotationShapeDto = AnnotationDto['shape'];

interface KeyframeDto<Value> {
  readonly timestampUs: TimestampUs;
  readonly value: Value;
  readonly easing: Easing;
}

/** How long a new effect lasts, unless its clip ends sooner. */
const NEW_EFFECT_US = 3_000_000;
/** The shortest effect a gesture can leave. */
export const MIN_EFFECT_US = 100_000;
const NEW_ZOOM_SCALE = 2;
const NEW_ZOOM_RAMP_US = 500_000;
const NEW_BLUR_INTENSITY = 0.03;
const NEW_BLUR_BOUNDS: Rectangle = { x: 0.35, y: 0.35, width: 0.3, height: 0.3 };
const NEW_TEXT = 'Your text';
const NEW_TEXT_SIZE = 0.06;
const NEW_ANNOTATION_LINE = 0.008;
const NEW_ANNOTATION_COLOR = '#ffffff';

const us = (value: number) => asTimestampUs(Math.max(0, Math.round(value)));

/** Where the clip's source span ends: its timeline length at its speed, from where it starts. */
export function clipSourceEndUs(clip: SnapshotClip): number {
  return clip.sourceStartUs + Math.round(clip.durationUs * clip.speed);
}

export function effectEndUs(effect: EffectDto): number {
  return effect.range.startUs + effect.range.durationUs;
}

/** Where a new effect at `sourceUs` goes: from there for three seconds, within the clip. */
function newRange(clip: SnapshotClip, sourceUs: number) {
  const end = clipSourceEndUs(clip);
  const durationUs = Math.min(NEW_EFFECT_US, end - clip.sourceStartUs);
  const startUs = clamp(Math.round(sourceUs), clip.sourceStartUs, end - durationUs);
  return { startUs: us(startUs), durationUs: asDurationUs(durationUs) };
}

/** Ramps as long as asked, but never more than a third of the zoom each. */
function rampUs(durationUs: number, wantedUs: number): number {
  return Math.max(0, Math.min(Math.round(wantedUs), Math.floor(durationUs / 3)));
}

/** A new still zoom at `sourceUs` of a clip's source, toward `target`. */
export function newZoom(
  id: string,
  clip: SnapshotClip,
  sourceUs: number,
  target: { readonly x: number; readonly y: number },
): ZoomDto {
  const range = newRange(clip, sourceUs);
  const ramp = rampUs(range.durationUs, NEW_ZOOM_RAMP_US);
  return {
    id: asEffectId(id),
    kind: 'zoom',
    range,
    enabled: true,
    poses: [
      {
        timestampUs: range.startUs,
        value: {
          anchor: { x: clamp(target.x, 0, 1), y: clamp(target.y, 0, 1) },
          scale: NEW_ZOOM_SCALE,
        },
        easing: 'ease-in-out',
      },
    ],
    easeInUs: ramp,
    easeOutUs: ramp,
    easing: 'ease-in-out',
  };
}

/**
 * A new text annotation at `sourceUs` of a clip's source, high in the middle
 * of the frame, on a label, with words to replace (ADR-011). It starts a fade
 * before, where there is room, so the frame it was added on shows it whole.
 */
export function newAnnotation(id: string, clip: SnapshotClip, sourceUs: number): AnnotationDto {
  return {
    id: asEffectId(id),
    kind: 'annotation',
    range: newRange(clip, sourceUs - ANNOTATION_FADE_US),
    enabled: true,
    shape: {
      kind: 'text',
      text: NEW_TEXT,
      at: { x: 0.5, y: 0.2 },
      size: NEW_TEXT_SIZE,
      color: NEW_ANNOTATION_COLOR,
      background: true,
    },
  };
}

/** The point an annotation marks: where its words are, its arrow's point, its box's middle. */
function annotationCentre(shape: AnnotationShapeDto): { readonly x: number; readonly y: number } {
  switch (shape.kind) {
    case 'text':
      return shape.at;
    case 'arrow':
      return shape.to;
    case 'box':
      return {
        x: shape.bounds.x + shape.bounds.width / 2,
        y: shape.bounds.y + shape.bounds.height / 2,
      };
  }
}

/** The annotation as another shape, marking the same place in the same colour. */
export function reshapedAnnotation(
  shape: AnnotationShapeDto,
  kind: AnnotationShapeDto['kind'],
): AnnotationShapeDto {
  if (shape.kind === kind) {
    return shape;
  }
  const centre = annotationCentre(shape);
  switch (kind) {
    case 'text':
      return {
        kind: 'text',
        text: NEW_TEXT,
        at: centre,
        size: NEW_TEXT_SIZE,
        color: shape.color,
        background: true,
      };
    case 'arrow': {
      // Pointing at the place from up and to the left, or the other way near that corner.
      const from = {
        x: centre.x > 0.15 ? centre.x - 0.12 : centre.x + 0.12,
        y: centre.y > 0.15 ? centre.y - 0.12 : centre.y + 0.12,
      };
      return {
        kind: 'arrow',
        from,
        to: centre,
        lineWidth: NEW_ANNOTATION_LINE,
        color: shape.color,
      };
    }
    case 'box': {
      const width = 0.3;
      const height = 0.2;
      return {
        kind: 'box',
        bounds: {
          x: clamp(centre.x - width / 2, 0, 1 - width),
          y: clamp(centre.y - height / 2, 0, 1 - height),
          width,
          height,
        },
        lineWidth: NEW_ANNOTATION_LINE,
        color: shape.color,
      };
    }
  }
}

/** A new still blur at `sourceUs` of a clip's source, over the middle of the frame. */
export function newBlur(id: string, clip: SnapshotClip, sourceUs: number): BlurDto {
  const range = newRange(clip, sourceUs);
  return {
    id: asEffectId(id),
    kind: 'blur',
    range,
    enabled: true,
    intensity: NEW_BLUR_INTENSITY,
    regions: [
      {
        timestampUs: range.startUs,
        value: [{ kind: 'rectangle', bounds: NEW_BLUR_BOUNDS }],
        easing: 'linear',
      },
    ],
  };
}

/** The part of an effect inside its clip, in timeline time; undefined while it is dormant. */
export function effectSpan(
  clip: SnapshotClip,
  effect: EffectDto,
): { readonly startUs: number; readonly endUs: number } | undefined {
  const start = Math.max(effect.range.startUs, clip.sourceStartUs);
  const end = Math.min(effectEndUs(effect), clipSourceEndUs(clip));
  if (end <= start) {
    return undefined;
  }
  return { startUs: timelineTimeUs(clip, start), endUs: timelineTimeUs(clip, end) };
}

/** An effect's keyframes, whatever it keys: a zoom's poses or a blur's masks. */
export function effectKeyframes(effect: EffectDto): readonly { readonly timestampUs: number }[] {
  return effect.kind === 'zoom' ? effect.poses : effect.kind === 'blur' ? effect.regions : [];
}

/** Keyframes that move with a moved effect and stay inside a resized one. */
function retimed<Value>(
  keyframes: readonly KeyframeDto<Value>[],
  from: EffectDto['range'],
  to: EffectDto['range'],
): readonly KeyframeDto<Value>[] {
  const moved = to.durationUs === from.durationUs;
  const shift = to.startUs - from.startUs;
  return keyframes.map((keyframe) => ({
    ...keyframe,
    timestampUs: us(
      moved
        ? keyframe.timestampUs + shift
        : clamp(keyframe.timestampUs, to.startUs, to.startUs + to.durationUs),
    ),
  }));
}

/**
 * An effect given a new source range: its keyframes move with it, or stay
 * inside it when it is resized, and a zoom keeps its ramps if they fit.
 */
export function retimeEffect(effect: EffectDto, startUs: number, durationUs: number): EffectDto {
  const range = { startUs: us(startUs), durationUs: asDurationUs(Math.round(durationUs)) };
  switch (effect.kind) {
    case 'zoom': {
      const half = Math.floor(range.durationUs / 2);
      return {
        ...effect,
        range,
        poses: retimed(effect.poses, effect.range, range),
        easeInUs: Math.min(effect.easeInUs, half),
        easeOutUs: Math.min(effect.easeOutUs, half),
      };
    }
    case 'blur':
      return { ...effect, range, regions: retimed(effect.regions, effect.range, range) };
    case 'annotation':
    case 'custom':
      return { ...effect, range };
  }
}

/**
 * The effect after a finished drag on the timeline: moved, or one end moved,
 * by `deltaUs`, never shorter than MIN_EFFECT_US and always partly over its
 * clip. Undefined when the drag changes nothing.
 */
export function draggedEffect(
  clip: SnapshotClip,
  effect: EffectDto,
  edge: 'move' | 'start' | 'end',
  deltaUs: number,
): EffectDto | undefined {
  const start: number = effect.range.startUs;
  const end = effectEndUs(effect);
  const clipEnd = clipSourceEndUs(clip);
  // The drag moved by timeline time; the effect lives in source time, at the clip's speed.
  const sourceDelta = Math.round(deltaUs * clip.speed);
  let newStart = start;
  let newEnd = end;
  if (edge === 'move') {
    const length = end - start;
    newStart = clamp(
      start + sourceDelta,
      Math.max(0, clip.sourceStartUs - length + MIN_EFFECT_US),
      clipEnd - MIN_EFFECT_US,
    );
    newEnd = newStart + length;
  } else if (edge === 'start') {
    newStart = clamp(start + sourceDelta, 0, Math.min(end, clipEnd) - MIN_EFFECT_US);
  } else {
    newEnd = Math.max(Math.max(start, clip.sourceStartUs) + MIN_EFFECT_US, end + sourceDelta);
  }
  return newStart === start && newEnd === end
    ? undefined
    : retimeEffect(effect, newStart, newEnd - newStart);
}

/** The keyframe within `toleranceUs` of `sourceUs`, as its index; -1 when there is none. */
export function keyframeIndexAt(
  keyframes: readonly { readonly timestampUs: number }[],
  sourceUs: number,
  toleranceUs: number,
): number {
  return keyframes.findIndex(
    (keyframe) => Math.abs(keyframe.timestampUs - sourceUs) <= toleranceUs,
  );
}

/** The keyframe edited at `sourceUs`: the one there, else a still effect's only one; -1 for neither. */
function editedIndex(
  keyframes: readonly { readonly timestampUs: number }[],
  sourceUs: number,
  toleranceUs: number,
): number {
  const index = keyframeIndexAt(keyframes, sourceUs, toleranceUs);
  return index !== -1 ? index : keyframes.length === 1 ? 0 : -1;
}

/** Keyframes with one more, at `sourceUs` kept inside `range`, in time order. */
function withKeyframe<Value>(
  keyframes: readonly KeyframeDto<Value>[],
  range: EffectDto['range'],
  sourceUs: number,
  value: Value,
  easing: Easing,
): readonly KeyframeDto<Value>[] {
  const timestampUs = us(clamp(sourceUs, range.startUs, range.startUs + range.durationUs));
  return [...keyframes, { timestampUs, value, easing }].sort(
    (first, second) => first.timestampUs - second.timestampUs,
  );
}

/**
 * Keyframes with the value at `sourceUs` changed: the keyframe there, or a
 * still effect's only keyframe, is changed; otherwise a keyframe is added
 * there from the value shown now, changed, so the effect moves to it from
 * its neighbours.
 */
function changedAt<Value>(
  keyframes: readonly KeyframeDto<Value>[],
  range: EffectDto['range'],
  sourceUs: number,
  toleranceUs: number,
  shownNow: () => Value,
  change: (value: Value) => Value,
  easing: Easing,
): readonly KeyframeDto<Value>[] {
  const index = editedIndex(keyframes, sourceUs, toleranceUs);
  return index === -1
    ? withKeyframe(keyframes, range, sourceUs, change(shownNow()), easing)
    : keyframes.map((keyframe, at) =>
        at === index ? { ...keyframe, value: change(keyframe.value) } : keyframe,
      );
}

/** Keyframes without the one at `index`; an effect keeps at least one. */
function without<Value>(
  keyframes: readonly KeyframeDto<Value>[],
  index: number,
): readonly KeyframeDto<Value>[] {
  return keyframes.length <= 1 ? keyframes : keyframes.filter((_keyframe, at) => at !== index);
}

// --- Blur masks ---------------------------------------------------------------

/** The blur's mask at `sourceUs`, holding its first or last keyframe outside them. */
export function blurMaskAt(blur: BlurDto, sourceUs: number): readonly BlurRegionDto[] {
  const at = clamp(sourceUs, blur.range.startUs, effectEndUs(blur) - 1);
  return blurRegionsAt({ ...blur, enabled: true }, at);
}

/** The blur with its mask at `sourceUs` changed (a still blur changes as a whole). */
export function editBlurMask(
  blur: BlurDto,
  sourceUs: number,
  mask: readonly BlurRegionDto[],
  toleranceUs: number,
): BlurDto {
  const regions = changedAt(
    blur.regions,
    blur.range,
    sourceUs,
    toleranceUs,
    () => mask,
    () => mask,
    'linear',
  );
  return { ...blur, regions };
}

/** The blur with a keyframe at `sourceUs` (inside the blur), holding `mask` or the mask there now. */
export function addBlurKeyframe(
  blur: BlurDto,
  sourceUs: number,
  mask: readonly BlurRegionDto[] = blurMaskAt(blur, sourceUs),
): BlurDto {
  return { ...blur, regions: withKeyframe(blur.regions, blur.range, sourceUs, mask, 'linear') };
}

/** The blur without the keyframe at `index`; a blur keeps at least one. */
export function removeBlurKeyframe(blur: BlurDto, index: number): BlurDto {
  return blur.regions.length <= 1 ? blur : { ...blur, regions: without(blur.regions, index) };
}

/** Every keyframe's first region in the new shape, so the mask never jumps between shapes. */
export function reshapeBlur(blur: BlurDto, kind: 'rectangle' | 'ellipse'): BlurDto {
  return {
    ...blur,
    regions: blur.regions.map((keyframe) => ({
      ...keyframe,
      value: keyframe.value.map((region, at) =>
        at === 0 && region.kind !== 'polygon' ? { kind, bounds: region.bounds } : region,
      ),
    })),
  };
}

// --- Zoom poses ----------------------------------------------------------------

/**
 * The pose a zoom shows at `sourceUs`: the pose of the keyframe edited there
 * (its own target, even where the frame keeps it from the centre), else the
 * pose of the view between keyframes.
 */
export function zoomPoseAt(zoom: ZoomDto, sourceUs: number, toleranceUs: number): ZoomPoseDto {
  const index = editedIndex(zoom.poses, sourceUs, toleranceUs);
  return zoom.poses[index]?.value ?? viewPose(zoomViewAt(zoom, sourceUs));
}

/** The zoom with its pose at `sourceUs` changed (a still zoom changes as a whole). */
export function editZoomPose(
  zoom: ZoomDto,
  sourceUs: number,
  patch: Partial<ZoomPoseDto>,
  toleranceUs: number,
): ZoomDto {
  const poses = changedAt(
    zoom.poses,
    zoom.range,
    sourceUs,
    toleranceUs,
    () => viewPose(zoomViewAt(zoom, sourceUs)),
    (pose) => ({ ...pose, ...patch }),
    'ease-in-out',
  );
  return { ...zoom, poses };
}

/** A pose turned to `degrees` about one axis; flat, without a rotation, once every axis is 0. */
/** The pose turned as `rotation` says: flat, with no rotation at all, when every angle is zero. */
function rotatedPose(pose: ZoomPoseDto, rotation: CameraRotation): ZoomPoseDto {
  const flat = { anchor: pose.anchor, scale: pose.scale };
  return rotation.x === 0 && rotation.y === 0 && rotation.z === 0 ? flat : { ...flat, rotation };
}

function turnedPose(pose: ZoomPoseDto, axis: keyof CameraRotation, degrees: number): ZoomPoseDto {
  return rotatedPose(pose, { x: 0, y: 0, z: 0, ...pose.rotation, [axis]: degrees });
}

/** The zoom with its pose at `sourceUs` turned about one axis, changed as editZoomPose changes it. */
export function editZoomTurn(
  zoom: ZoomDto,
  sourceUs: number,
  axis: keyof CameraRotation,
  degrees: number,
  toleranceUs: number,
): ZoomDto {
  const poses = changedAt(
    zoom.poses,
    zoom.range,
    sourceUs,
    toleranceUs,
    () => viewPose(zoomViewAt(zoom, sourceUs)),
    (pose) => turnedPose(pose, axis, degrees),
    'ease-in-out',
  );
  return { ...zoom, poses };
}

/** The zoom with a keyframe at `sourceUs` (inside the zoom), holding the pose shown there now. */
export function addZoomKeyframe(zoom: ZoomDto, sourceUs: number): ZoomDto {
  const pose = viewPose(zoomViewAt(zoom, sourceUs));
  return { ...zoom, poses: withKeyframe(zoom.poses, zoom.range, sourceUs, pose, 'ease-in-out') };
}

/** The zoom without the keyframe at `index`; a zoom keeps at least one. */
export function removeZoomKeyframe(zoom: ZoomDto, index: number): ZoomDto {
  return { ...zoom, poses: without(zoom.poses, index) };
}

/**
 * Turns the zoom's pose at `sourceUs` to `rotation` as a whole, as a drag on
 * the picture does: a still zoom changes, a moving one gets a keyframe there.
 */
export function editZoomRotation(
  zoom: ZoomDto,
  sourceUs: number,
  rotation: CameraRotation,
  toleranceUs: number,
): ZoomDto {
  const poses = changedAt(
    zoom.poses,
    zoom.range,
    sourceUs,
    toleranceUs,
    () => viewPose(zoomViewAt(zoom, sourceUs)),
    (pose) => rotatedPose(pose, rotation),
    'ease-in-out',
  );
  return { ...zoom, poses };
}

/** Makes the camera stop at a zoom's keyframe `index`, or flow on through it. */
export function holdZoomKeyframe(zoom: ZoomDto, index: number, hold: boolean): ZoomDto {
  return {
    ...zoom,
    poses: zoom.poses.map((keyframe, at) => {
      if (at !== index) {
        return keyframe;
      }
      const { hold: _held, ...flowing } = keyframe;
      return hold ? { ...flowing, hold: true } : flowing;
    }),
  };
}

/** A zoom scale the domain accepts, at one decimal. */
export function zoomScale(value: number): number {
  return clamp(Math.round(value * 10) / 10, 1, MAX_ZOOM_SCALE);
}
