import { describe, expect, it } from 'vitest';

import { asTimestampUs } from '@usee/contracts';

import { followPointer } from './camera-follow';
import { FULL_FRAME, type CameraView } from './camera-view';
import { deriveCursorPath, pointerTrackFromStream, type CursorPath } from './cursor-path';
import { turnToward } from './focus';
import type { PointerEvent } from './interaction';

const SECOND = 1_000_000;

/** A pointer that moves in straight lines between the given points, in session seconds. */
function pathThrough(points: readonly (readonly [number, number, number])[]): CursorPath {
  const events: PointerEvent[] = points.map(([seconds, x, y]) => ({
    type: 'move',
    timeUs: asTimestampUs(Math.round(seconds * SECOND)),
    x,
    y,
  }));
  return deriveCursorPath(
    pointerTrackFromStream({
      coordinateSpace: 'capture',
      display: { width: 1920, height: 1080, dpiScale: 1 },
      events,
    }),
    0,
  );
}

const zoomedAt = (centerX: number, centerY: number): CameraView => ({
  scale: 2,
  centerX,
  centerY,
});

describe('the generated camera following the pointer', () => {
  it('leaves a view of the whole frame alone: there is nothing to follow', () => {
    const path = pathThrough([[0, 0.95, 0.95]]);
    expect(followPointer(FULL_FRAME, path, SECOND)).toBe(FULL_FRAME);
  });

  it('holds while the pointer stays near the middle of the view', () => {
    const view = zoomedAt(0.5, 0.5);
    // At scale 2 the view is half the frame; the pointer may stray 0.6 of its half-size.
    expect(followPointer(view, pathThrough([[0, 0.6, 0.45]]), SECOND)).toBe(view);
  });

  it('moves just enough to keep a pointer that strays in view, never past the frame', () => {
    const view = zoomedAt(0.5, 0.5);
    const right = followPointer(view, pathThrough([[0, 0.8, 0.5]]), SECOND);
    expect(right.centerX).toBeCloseTo(0.65, 6);
    expect(right.centerY).toBe(0.5);
    const corner = followPointer(view, pathThrough([[0, 1, 0]]), SECOND);
    expect(corner).toMatchObject({ centerX: 0.75, centerY: 0.25 });
  });

  it('does not trail a moving pointer: it follows it averaged as far ahead as behind', () => {
    // Across the frame in four seconds: at 2 s the pointer is at 0.55, moving steadily.
    const path = pathThrough([
      [0, 0.15, 0.5],
      [4, 0.95, 0.5],
    ]);
    const view = followPointer(zoomedAt(0.25, 0.5), path, 2 * SECOND);
    expect(view.centerX).toBeCloseTo(0.55 - 0.15, 4);
  });

  it('glides over a jump of the pointer instead of snapping to it', () => {
    const path = pathThrough([
      [0, 0.3, 0.5],
      [2, 0.3, 0.5],
      [2.001, 0.9, 0.5],
      [5, 0.9, 0.5],
    ]);
    const xs = [1.5, 1.99, 2.01, 2.8].map(
      (seconds) => followPointer(zoomedAt(0.3, 0.5), path, seconds * SECOND).centerX,
    );
    for (let index = 1; index < xs.length; index += 1) {
      expect(xs[index] ?? 0).toBeGreaterThanOrEqual(xs[index - 1] ?? 0);
    }
    // Across the jump itself it moves a little, where a snap would cross 0.45 of the frame.
    expect((xs[2] ?? 0) - (xs[1] ?? 0)).toBeLessThan(0.05);
    expect(xs[3]).toBeCloseTo(0.75, 6);
  });

  it('turns a 3D view toward where it now looks, as the planned one turns toward its own', () => {
    const turn3d = 0.8;
    const rotation = turnToward({ x: 0.5, y: 0.5 }, turn3d);
    const view: CameraView = { ...zoomedAt(0.5, 0.5), ...(rotation ? { rotation } : {}) };
    const moved = followPointer(view, pathThrough([[0, 0.8, 0.5]]), SECOND, turn3d);
    const planned = turnToward({ x: moved.centerX, y: moved.centerY }, turn3d);
    expect(moved.rotation?.y).toBeCloseTo(planned?.y ?? 0, 1);
    expect(moved.rotation?.x).toBeCloseTo(planned?.x ?? 0, 1);
    // Flat, it stays flat.
    expect(
      followPointer(zoomedAt(0.5, 0.5), pathThrough([[0, 0.8, 0.5]]), SECOND, turn3d).rotation,
    ).toBeUndefined();
  });
});
