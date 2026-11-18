import { describe, expect, it } from 'vitest';

import { asAssetId, asClipId, asDurationUs, asTimestampUs, effectSchema } from '@usee/contracts';
import { activeAnnotationsAt, cameraViewAt, effectProblem } from '@usee/domain';

import {
  addBlurKeyframe,
  addZoomKeyframe,
  blurMaskAt,
  draggedEffect,
  editBlurMask,
  editZoomPose,
  editZoomRotation,
  editZoomTurn,
  effectSpan,
  holdZoomKeyframe,
  MIN_EFFECT_US,
  newAnnotation,
  newBlur,
  newZoom,
  removeBlurKeyframe,
  removeZoomKeyframe,
  reshapeBlur,
  reshapedAnnotation,
  retimeEffect,
  zoomPoseAt,
  type BlurDto,
  type ZoomDto,
} from './effect-editing';
import type { SnapshotClip } from './timeline-math';

const SECOND = 1_000_000;

// A clip showing source 10-20 s of its media, at 5 s on the timeline.
const clip: SnapshotClip = {
  id: asClipId('clip'),
  assetId: asAssetId('recording'),
  sourceStartUs: asTimestampUs(10 * SECOND),
  durationUs: asDurationUs(10 * SECOND),
  timelineStartUs: asTimestampUs(5 * SECOND),
  speed: 1,
  effects: [],
};

/** Valid on the wire and in the domain. */
function expectValid(effect: unknown) {
  const parsed = effectSchema.safeParse(effect);
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(effectProblem(parsed.data)).toBeUndefined();
  }
}

const rectangle = (x: number, y: number) =>
  [{ kind: 'rectangle', bounds: { x, y, width: 0.2, height: 0.2 } }] as const;

describe('new effects', () => {
  it('starts a zoom at the playhead, toward the target, for three seconds', () => {
    const zoom = newZoom('z', clip, 12 * SECOND, { x: 0.8, y: 1.4 });
    expect(zoom.range).toEqual({ startUs: 12 * SECOND, durationUs: 3 * SECOND });
    expect(zoom.poses).toEqual([
      {
        timestampUs: 12 * SECOND,
        value: { anchor: { x: 0.8, y: 1 }, scale: 2 },
        easing: 'ease-in-out',
      },
    ]);
    expect(zoom.easeInUs).toBe(500_000);
    expectValid(zoom);
  });

  it('keeps a new effect inside its clip', () => {
    const late = newBlur('b', clip, 19.5 * SECOND);
    expect(late.range).toEqual({ startUs: 17 * SECOND, durationUs: 3 * SECOND });
    expect(late.regions[0]?.timestampUs).toBe(17 * SECOND);
    expectValid(late);

    const short = { ...clip, durationUs: asDurationUs(SECOND) };
    const zoom = newZoom('z', short, 10.5 * SECOND, { x: 0.5, y: 0.5 });
    expect(zoom.range).toEqual({ startUs: 10 * SECOND, durationUs: SECOND });
    expect(zoom.easeInUs + zoom.easeOutUs).toBeLessThanOrEqual(SECOND);
    expectValid(zoom);
  });
});

describe('new annotations', () => {
  it('adds words to replace, high in the middle, for three seconds, whole at the playhead', () => {
    const note = newAnnotation('n', clip, 12 * SECOND);
    // It fades in before the playhead, so the frame it was added on shows it.
    expect(note.range).toEqual({ startUs: 11.8 * SECOND, durationUs: 3 * SECOND });
    expect(activeAnnotationsAt([note], 12 * SECOND)[0]?.opacity).toBe(1);
    expect(note.shape).toMatchObject({ kind: 'text', text: 'Your text', at: { x: 0.5, y: 0.2 } });
    expectValid(note);
  });

  it('turns into an arrow or a box marking the same place, in the same colour', () => {
    const note = newAnnotation('n', clip, 12 * SECOND);
    const text = {
      kind: 'text',
      text: 'Your text',
      at: { x: 0.5, y: 0.2 },
      size: 0.06,
      color: '#ff3b30',
      background: true,
    } as const;
    const arrow = reshapedAnnotation(text, 'arrow');
    expect(arrow).toMatchObject({ kind: 'arrow', to: { x: 0.5, y: 0.2 }, color: '#ff3b30' });
    expectValid({ ...note, shape: arrow });
    const box = reshapedAnnotation(arrow, 'box');
    expect(box).toMatchObject({
      kind: 'box',
      bounds: { x: 0.35, y: 0.1, width: 0.3, height: 0.2 },
    });
    expectValid({ ...note, shape: box });
    // Near a corner it still fits on the frame.
    const corner = reshapedAnnotation({ ...text, at: { x: 0.02, y: 0.98 } }, 'box');
    expectValid({ ...note, shape: corner });
    expectValid({
      ...note,
      shape: reshapedAnnotation({ ...text, at: { x: 0.05, y: 0.05 } }, 'arrow'),
    });
    expect(reshapedAnnotation(box, 'text')).toMatchObject({ kind: 'text', at: { x: 0.5, y: 0.2 } });
  });
});

describe('effects on the timeline', () => {
  it('shows the part of an effect inside its clip', () => {
    const zoom = newZoom('z', clip, 12 * SECOND, { x: 0.5, y: 0.5 });
    expect(effectSpan(clip, zoom)).toEqual({ startUs: 7 * SECOND, endUs: 10 * SECOND });
    const spilling = retimeEffect(zoom, 8 * SECOND, 4 * SECOND);
    expect(effectSpan(clip, spilling)).toEqual({ startUs: 5 * SECOND, endUs: 7 * SECOND });
    expect(effectSpan(clip, retimeEffect(zoom, 2 * SECOND, 4 * SECOND))).toBeUndefined();
  });

  it('keeps ramps and keyframes valid when an effect is moved or resized', () => {
    const zoom = newZoom('z', clip, 12 * SECOND, { x: 0.5, y: 0.5 });
    const shortened = retimeEffect(zoom, 12 * SECOND, 600_000);
    expect(shortened.kind === 'zoom' && shortened.easeInUs).toBe(300_000);
    expectValid(shortened);

    const blur = addBlurKeyframe(newBlur('b', clip, 12 * SECOND), 14 * SECOND, rectangle(0.5, 0.5));
    const moved = retimeEffect(blur, 13 * SECOND, 3 * SECOND) as BlurDto;
    expect(moved.regions.map((keyframe) => keyframe.timestampUs)).toEqual([
      13 * SECOND,
      15 * SECOND,
    ]);
    expectValid(moved);
    const trimmed = retimeEffect(blur, 12 * SECOND, SECOND) as BlurDto;
    expect(trimmed.regions.map((keyframe) => keyframe.timestampUs)).toEqual([
      12 * SECOND,
      13 * SECOND,
    ]);
    expectValid(trimmed);
  });
});

describe('dragging effects on the timeline', () => {
  const zoom = newZoom('z', clip, 12 * SECOND, { x: 0.5, y: 0.5 });

  it('moves an effect, keeping some of it over its clip', () => {
    expect(draggedEffect(clip, zoom, 'move', SECOND)?.range).toEqual({
      startUs: 13 * SECOND,
      durationUs: 3 * SECOND,
    });
    // Far past the clip's end, it stops with MIN_EFFECT_US still over the clip.
    expect(draggedEffect(clip, zoom, 'move', 60 * SECOND)?.range.startUs).toBe(
      20 * SECOND - MIN_EFFECT_US,
    );
    expect(draggedEffect(clip, zoom, 'move', -60 * SECOND)?.range.startUs).toBe(
      7 * SECOND + MIN_EFFECT_US,
    );
  });

  it('moves either end, never past the other', () => {
    expect(draggedEffect(clip, zoom, 'start', -SECOND)?.range).toEqual({
      startUs: 11 * SECOND,
      durationUs: 4 * SECOND,
    });
    expect(draggedEffect(clip, zoom, 'start', 10 * SECOND)?.range).toEqual({
      startUs: 15 * SECOND - MIN_EFFECT_US,
      durationUs: MIN_EFFECT_US,
    });
    expect(draggedEffect(clip, zoom, 'end', -10 * SECOND)?.range.durationUs).toBe(MIN_EFFECT_US);
    expectValid(draggedEffect(clip, zoom, 'end', -10 * SECOND));
    expect(draggedEffect(clip, zoom, 'end', 0)).toBeUndefined();
  });
});

describe('blur keyframes', () => {
  const still = newBlur('b', clip, 12 * SECOND);
  const tolerance = 8_000;

  it('changes a still blur’s mask wherever the playhead is', () => {
    const edited = editBlurMask(still, 13.5 * SECOND, rectangle(0.1, 0.1), tolerance);
    expect(edited.regions).toHaveLength(1);
    expect(edited.regions[0]?.value).toEqual(rectangle(0.1, 0.1));
  });

  it('adds a keyframe where a moving mask is edited, or changes the one there', () => {
    const moving = addBlurKeyframe(still, 14 * SECOND, rectangle(0.6, 0.6));
    const added = editBlurMask(moving, 13 * SECOND, rectangle(0.4, 0.4), tolerance);
    expect(added.regions.map((keyframe) => keyframe.timestampUs)).toEqual([
      12 * SECOND,
      13 * SECOND,
      14 * SECOND,
    ]);
    expectValid(added);
    const changed = editBlurMask(moving, 14 * SECOND + 5_000, rectangle(0.7, 0.7), tolerance);
    expect(changed.regions).toHaveLength(2);
    expect(changed.regions[1]?.value).toEqual(rectangle(0.7, 0.7));
  });

  it('adds a keyframe holding the mask already there, and keeps the last one', () => {
    const moving = addBlurKeyframe(still, 14 * SECOND, rectangle(0.55, 0.55));
    const between = addBlurKeyframe(moving, 13 * SECOND);
    expect(between.regions[1]?.value).toEqual(blurMaskAt(moving, 13 * SECOND));
    expect(removeBlurKeyframe(between, 1).regions).toEqual(moving.regions);
    expect(removeBlurKeyframe(still, 0)).toBe(still);
  });

  it('changes the shape of every keyframe together', () => {
    const moving = addBlurKeyframe(still, 14 * SECOND, rectangle(0.6, 0.6));
    const round = reshapeBlur(moving, 'ellipse');
    expect(round.regions.map((keyframe) => keyframe.value[0]?.kind)).toEqual([
      'ellipse',
      'ellipse',
    ]);
    expectValid(round);
  });
});

describe('zoom keyframes', () => {
  const tolerance = 8_000;
  // A still zoom at 12-15 s whose target sits near the frame's left edge.
  const still = newZoom('z', clip, 12 * SECOND, { x: 0.1, y: 0.5 });

  it('changes a still zoom as a whole, keeping its own target', () => {
    const scaled = editZoomPose(still, 14 * SECOND, { scale: 3 }, tolerance);
    expect(scaled.poses).toHaveLength(1);
    // The target stays where it was put, though the frame keeps it off the centre.
    expect(scaled.poses[0]?.value).toEqual({ anchor: { x: 0.1, y: 0.5 }, scale: 3 });
    expect(zoomPoseAt(scaled, 13 * SECOND, tolerance)).toEqual(scaled.poses[0]?.value);
  });

  it('adds a keyframe where the camera already is, then moves it', () => {
    const before = cameraViewAt([still], 13.5 * SECOND);
    const keyed = addZoomKeyframe(still, 13.5 * SECOND);
    expect(keyed.poses.map((pose) => pose.timestampUs)).toEqual([12 * SECOND, 13.5 * SECOND]);
    expect(cameraViewAt([keyed], 13.5 * SECOND)).toEqual(before);
    expectValid(keyed);

    // With two keyframes, an edit between them adds a third; one at a keyframe changes it.
    const aimed = editZoomPose(keyed, 13.5 * SECOND, { anchor: { x: 0.8, y: 0.2 } }, tolerance);
    expect(aimed.poses[1]?.value.anchor).toEqual({ x: 0.8, y: 0.2 });
    const third = editZoomPose(aimed, 13 * SECOND, { scale: 4 }, tolerance);
    expect(third.poses).toHaveLength(3);
    expect(third.poses[1]?.value.scale).toBe(4);
    expectValid(third);
    expect(removeZoomKeyframe(third, 1).poses).toEqual(aimed.poses);
    expect(removeZoomKeyframe(still, 0)).toEqual(still);
  });

  it('turns a still zoom as a whole by a drag, flat again at zero', () => {
    const turned = editZoomRotation(still, 13 * SECOND, { x: 12, y: -8, z: 0 }, tolerance);
    expect(turned.poses).toHaveLength(1);
    expect(turned.poses[0]?.value.rotation).toEqual({ x: 12, y: -8, z: 0 });
    expectValid(turned);
    expect(editZoomRotation(turned, 13 * SECOND, { x: 0, y: 0, z: 0 }, tolerance)).toEqual(still);
  });

  it('holds the camera at a keyframe, or lets it flow on through', () => {
    const keyed = addZoomKeyframe(addZoomKeyframe(still, 13 * SECOND), 14 * SECOND);
    expect(keyed.poses.every((pose) => pose.hold === undefined)).toBe(true);
    const held = holdZoomKeyframe(keyed, 1, true);
    expect(held.poses.map((pose) => pose.hold)).toEqual([undefined, true, undefined]);
    expectValid(held);
    expect(holdZoomKeyframe(held, 1, false)).toEqual(keyed);
  });

  it('turns a zoom’s pose about one axis at a time, flat again at zero', () => {
    const tipped = editZoomTurn(still, 14 * SECOND, 'x', 12, tolerance);
    expect(tipped.poses[0]?.value).toEqual({
      anchor: { x: 0.1, y: 0.5 },
      scale: 2,
      rotation: { x: 12, y: 0, z: 0 },
    });
    const rolled = editZoomTurn(tipped, 14 * SECOND, 'z', -5, tolerance);
    expect(rolled.poses[0]?.value.rotation).toEqual({ x: 12, y: 0, z: -5 });
    expectValid(rolled);
    // Back to zero on every axis, the pose is flat, as it began.
    const level = editZoomTurn(rolled, 14 * SECOND, 'x', 0, tolerance);
    expect(editZoomTurn(level, 14 * SECOND, 'z', 0, tolerance).poses[0]?.value).toEqual(
      still.poses[0]?.value,
    );
  });

  it('moves the keyframes with a moved zoom and keeps them inside a resized one', () => {
    const keyed = addZoomKeyframe(still, 14 * SECOND);
    const moved = retimeEffect(keyed, 13 * SECOND, 3 * SECOND) as ZoomDto;
    expect(moved.poses.map((pose) => pose.timestampUs)).toEqual([13 * SECOND, 15 * SECOND]);
    const trimmed = retimeEffect(keyed, 12 * SECOND, SECOND) as ZoomDto;
    expect(trimmed.poses.map((pose) => pose.timestampUs)).toEqual([12 * SECOND, 13 * SECOND]);
    expectValid(trimmed);
  });
});
