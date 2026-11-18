import { describe, expect, it } from 'vitest';

import { cardTransform, FULL_FRAME, type CameraView } from '@usee/domain';

import { cardDetail, cardOutline } from './camera-projection';

const ASPECT = 16 / 9;
const place = { x: 100, y: 50, w: 1600, h: 900, radius: 0 };

const outlineOf = (view: CameraView, radius = 0) =>
  cardOutline(cardTransform(view, ASPECT).toOutput, { ...place, radius });

describe('a card on the canvas', () => {
  it('outlines a flat card exactly at its place', () => {
    const outline = outlineOf(FULL_FRAME);
    expect(outline).toHaveLength(4);
    const expected = [
      [100, 50],
      [1700, 50],
      [1700, 950],
      [100, 950],
    ];
    outline.forEach((point, index) => {
      expect(point.x).toBeCloseTo(expected[index]?.[0] ?? NaN, 6);
      expect(point.y).toBeCloseTo(expected[index]?.[1] ?? NaN, 6);
    });
  });

  it('rounds the corners of a card as the picture’s, turning them with it', () => {
    const outline = outlineOf({ ...FULL_FRAME, rotation: { x: 0, y: 20, z: 0 } }, 90);
    expect(outline).toHaveLength(36);
    // The left comes closer, past the place; the right moves away, inside it.
    expect(Math.min(...outline.map((point) => point.x))).toBeLessThan(place.x);
    expect(Math.max(...outline.map((point) => point.x))).toBeLessThan(place.x + place.w);
  });

  it('shrinks a pulled-out card about the middle of its place', () => {
    const outline = outlineOf({ ...FULL_FRAME, scale: 0.5 });
    expect(outline[0]?.x).toBeCloseTo(500, 6);
    expect(outline[2]?.y).toBeCloseTo(725, 6);
  });

  it('composes a turned card in more detail where it comes nearer, within a bound', () => {
    expect(cardDetail(cardTransform(FULL_FRAME, ASPECT).toOutput, place)).toBeCloseTo(1, 6);
    const turned = cardDetail(
      cardTransform({ ...FULL_FRAME, rotation: { x: 0, y: 25, z: 0 } }, ASPECT).toOutput,
      place,
    );
    expect(turned).toBeGreaterThan(1.1);
    expect(turned).toBeLessThanOrEqual(4);
  });
});
