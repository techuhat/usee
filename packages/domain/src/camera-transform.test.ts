import { describe, expect, it } from 'vitest';

import { asDurationUs, asEffectId, asTimestampUs } from '@usee/contracts';

import type { CameraRotation } from './camera';
import { applyHomography, cardTransform, isCropView, isFlatView } from './camera-transform';
import { cameraViewAt, clampView, FULL_FRAME, type CameraView } from './camera-view';
import { effectProblem } from './effect-rules';
import type { ZoomEffect } from './effects';

const SECOND = 1_000_000;
const ASPECT = 16 / 9;
const CORNERS = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
] as const;

// A small deterministic generator, so a failing property reproduces exactly.
function randomFrom(seed: number) {
  let state = seed;
  return () => (state = (state * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
}

describe('turned camera poses', () => {
  it('turns the camera with a zoom’s poses, easing in and out with it', () => {
    const zoom: ZoomEffect = {
      id: asEffectId('turned'),
      kind: 'zoom',
      range: { startUs: asTimestampUs(0), durationUs: asDurationUs(4 * SECOND) },
      enabled: true,
      poses: [
        {
          timestampUs: asTimestampUs(0),
          value: { anchor: { x: 0.5, y: 0.5 }, scale: 2, rotation: { x: 12, y: -6, z: 4 } },
          easing: 'linear',
        },
      ],
      easeInUs: 1_000_000,
      easeOutUs: 1_000_000,
      easing: 'linear',
    };
    expect(cameraViewAt([zoom], 2 * SECOND).rotation).toEqual({ x: 12, y: -6, z: 4 });
    const halfway = cameraViewAt([zoom], 0.5 * SECOND).rotation;
    expect(halfway?.x).toBeCloseTo(6, 9);
    expect(halfway?.y).toBeCloseTo(-3, 9);
    expect(cameraViewAt([zoom], 5 * SECOND)).toEqual(FULL_FRAME);
  });

  it('turns a zoom at most 30 degrees each way', () => {
    const zoom = (rotation: CameraRotation): ZoomEffect => ({
      id: asEffectId('turned'),
      kind: 'zoom',
      range: { startUs: asTimestampUs(0), durationUs: asDurationUs(SECOND) },
      enabled: true,
      poses: [
        {
          timestampUs: asTimestampUs(0),
          value: { anchor: { x: 0.5, y: 0.5 }, scale: 2, rotation },
          easing: 'linear',
        },
      ],
      easeInUs: 0,
      easeOutUs: 0,
      easing: 'linear',
    });
    expect(effectProblem(zoom({ x: 30, y: -30, z: 30 }))).toBeUndefined();
    expect(effectProblem(zoom({ x: 31, y: 0, z: 0 }))).toBe(
      'a zoom turns at most 30 degrees each way',
    );
    expect(effectProblem(zoom({ x: 0, y: 0, z: Number.NaN }))).toBe(
      'a zoom turns at most 30 degrees each way',
    );
  });
});

describe('zoom rules for 3D motion', () => {
  const zoom = (scale: number, lens?: number): ZoomEffect => ({
    id: asEffectId('pulled'),
    kind: 'zoom',
    range: { startUs: asTimestampUs(0), durationUs: asDurationUs(SECOND) },
    enabled: true,
    poses: [
      {
        timestampUs: asTimestampUs(0),
        value: { anchor: { x: 0.5, y: 0.5 }, scale },
        easing: 'linear',
      },
    ],
    easeInUs: 0,
    easeOutUs: 0,
    easing: 'linear',
    ...(lens === undefined ? {} : { lens }),
  });

  it('pulls back to half the picture at most, through a lens of 15 to 60 degrees', () => {
    expect(effectProblem(zoom(0.5))).toBeUndefined();
    expect(effectProblem(zoom(0.45))).toBe('zoom scale must be 0.5-8');
    expect(effectProblem(zoom(2, 15))).toBeUndefined();
    expect(effectProblem(zoom(2, 60))).toBeUndefined();
    expect(effectProblem(zoom(2, 70))).toBe("a zoom's lens is 15-60 degrees");
  });
});

describe('card transform', () => {
  const card = (view: CameraView, x: number, y: number) =>
    applyHomography(cardTransform(view, ASPECT).toOutput, x, y);

  it('leaves a flat card in its place, showing the crop', () => {
    const view = clampView({ scale: 2, centerX: 0.3, centerY: 0.6 });
    expect(isCropView(view)).toBe(true);
    expect(isFlatView({ ...view, rotation: { x: 0, y: 0, z: 0 } })).toBe(true);
    const { crop, toOutput } = cardTransform(view, ASPECT);
    expect(crop).toEqual(view);
    for (const [x, y] of CORNERS) {
      const corner = applyHomography(toOutput, x, y);
      expect(corner.x).toBeCloseTo(x, 9);
      expect(corner.y).toBeCloseTo(y, 9);
    }
  });

  it('shrinks a pulled-out card about its centre, showing the whole frame', () => {
    const view = clampView({ scale: 0.5, centerX: 0.2, centerY: 0.9 });
    expect(view.centerX).toBe(0.5);
    expect(isCropView(view)).toBe(false);
    expect(cardTransform(view, ASPECT).crop).toEqual(FULL_FRAME);
    expect(card(view, 0, 0).x).toBeCloseTo(0.25, 9);
    expect(card(view, 1, 1).y).toBeCloseTo(0.75, 9);
  });

  it('turns the card about its centre, so the canvas shows past its edges', () => {
    // y moves the right edge away: it looks shorter, and the left comes closer, past its place.
    const swung: CameraView = { ...FULL_FRAME, rotation: { x: 0, y: 20, z: 0 } };
    expect(isCropView(swung)).toBe(false);
    const height = (x: number) => card(swung, x, 1).y - card(swung, x, 0).y;
    expect(height(1)).toBeLessThan(1);
    expect(height(0)).toBeGreaterThan(1);
    expect(card(swung, 1, 0.5).x).toBeLessThan(1);
    expect(card(swung, 0, 0.5).x).toBeLessThan(0);
    // x moves the top edge away; z turns it clockwise.
    const tipped: CameraView = { ...FULL_FRAME, rotation: { x: 15, y: 0, z: 0 } };
    expect(card(tipped, 1, 0).x - card(tipped, 0, 0).x).toBeLessThan(
      card(tipped, 1, 1).x - card(tipped, 0, 1).x,
    );
    expect(card({ ...FULL_FRAME, rotation: { x: 0, y: 0, z: 10 } }, 0.8, 0.5).y).toBeGreaterThan(
      0.5,
    );
    // The centre stays put, however the card turns.
    const middle = card(
      { scale: 2, centerX: 0.2, centerY: 0.7, rotation: { x: 9, y: -14, z: 6 } },
      0.5,
      0.5,
    );
    expect(middle.x).toBeCloseTo(0.5, 9);
    expect(middle.y).toBeCloseTo(0.5, 9);
  });

  it('looks deeper through a wider lens', () => {
    const swung = (lens: number): CameraView => ({
      ...FULL_FRAME,
      rotation: { x: 0, y: 20, z: 0 },
      lens,
    });
    const squeeze = (view: CameraView) =>
      (card(view, 1, 1).y - card(view, 1, 0).y) / (card(view, 0, 1).y - card(view, 0, 0).y);
    expect(squeeze(swung(60))).toBeLessThan(squeeze(swung(30)));
    expect(squeeze(swung(30))).toBeLessThan(squeeze(swung(15)));
    expect(squeeze(swung(30))).toBeCloseTo(
      squeeze({ ...FULL_FRAME, rotation: { x: 0, y: 20, z: 0 } }),
      9,
    );
  });

  it('maps back from where the card shows to the card point there', () => {
    const random = randomFrom(23);
    for (let run = 0; run < 300; run += 1) {
      const view: CameraView = {
        scale: 0.5 + random() * 3.5,
        centerX: random(),
        centerY: random(),
        rotation: { x: (random() - 0.5) * 60, y: (random() - 0.5) * 60, z: (random() - 0.5) * 60 },
        lens: 15 + random() * 45,
      };
      const aspect = 0.5 + random() * 2.5;
      const { toOutput, toSource } = cardTransform(clampView(view), aspect);
      for (const [x, y] of [...CORNERS, [0.5, 0.5], [random(), random()]] as const) {
        const shown = applyHomography(toOutput, x, y);
        const back = applyHomography(toSource, shown.x, shown.y);
        expect(back.x).toBeCloseTo(x, 6);
        expect(back.y).toBeCloseTo(y, 6);
      }
    }
  });
});
