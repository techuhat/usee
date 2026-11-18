import { describe, expect, it } from 'vitest';

import { asDurationUs, asEffectId, asTimestampUs } from '@usee/contracts';

import { cameraViewAt, FULL_FRAME, zoomProgress } from './camera-view';
import { pointerTrackFromStream } from './cursor-path';
import { effectProblem } from './effect-rules';
import type { ZoomEffect } from './effects';
import {
  clickFocusCandidates,
  DEFAULT_CAMERA_PLAN,
  generatedZoomEffects,
  planCameraTrack,
  restFocusCandidates,
  turnToward,
  type FocusCandidate,
} from './focus';
import type { PointerButton, PointerEvent } from './interaction';

const SECOND = 1_000_000;

const click = (
  seconds: number,
  x: number,
  y: number,
  button: PointerButton = 'left',
): PointerEvent => ({
  type: 'down',
  timeUs: asTimestampUs(Math.round(seconds * SECOND)),
  x,
  y,
  button,
});

const candidate = (seconds: number, x: number, y: number): FocusCandidate => ({
  timeUs: Math.round(seconds * SECOND),
  x,
  y,
  weight: 1,
});

function randomFrom(seed: number) {
  let state = seed;
  return () => (state = (state * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
}

describe('click-based focus', () => {
  it('takes left and right clicks on the captured display', () => {
    const track = pointerTrackFromStream({
      coordinateSpace: 'capture',
      display: { width: 1920, height: 1080, dpiScale: 1 },
      events: [
        click(1, 0.2, 0.3),
        click(2, 0.6, 0.6, 'right'),
        click(3, 0.5, 0.5, 'middle'),
        click(4, 1.2, 0.5), // on another display
      ],
    });
    expect(clickFocusCandidates(track)).toEqual([candidate(1, 0.2, 0.3), candidate(2, 0.6, 0.6)]);
  });
});

describe('camera planner', () => {
  it('plans a recorded sequence of clicks the same way every time', () => {
    // Two clicks close together, a third nearby, then one far off much later.
    // The camera holds on the first click until it must pan to reach the second.
    const plan = planCameraTrack(
      [
        candidate(2, 0.2, 0.3),
        candidate(3, 0.7, 0.4),
        candidate(3.5, 0.72, 0.42),
        candidate(12, 0.5, 0.8),
      ],
      14 * SECOND,
    );
    expect(plan).toEqual([
      {
        id: 'auto-2000000',
        startUs: 1_000_000,
        durationUs: 4_000_000,
        poses: [
          { timestampUs: 1_600_000, anchor: { x: 0.2, y: 0.3 } },
          { timestampUs: 2_000_000, anchor: { x: 0.2, y: 0.3 } },
          { timestampUs: 2_600_000, anchor: { x: 0.7, y: 0.4 } },
        ],
        easeInUs: 700_000,
        easeOutUs: 700_000,
      },
      {
        id: 'auto-12000000',
        startUs: 11_000_000,
        durationUs: 2_500_000,
        poses: [{ timestampUs: 11_600_000, anchor: { x: 0.5, y: 0.8 } }],
        easeInUs: 700_000,
        easeOutUs: 700_000,
      },
    ]);
    expect(planCameraTrack([], 14 * SECOND)).toEqual([]);
  });

  it('keeps zooms inside the session, the ramps short enough', () => {
    const [early] = planCameraTrack([candidate(0.3, 0.5, 0.5)], 1 * SECOND);
    expect(early).toMatchObject({ startUs: 0, durationUs: 1_000_000, easeInUs: 333_333 });
  });

  it('plans valid zooms that are fully in by every first click of a group', () => {
    const random = randomFrom(3);
    for (let run = 0; run < 200; run += 1) {
      const sessionEndUs = (5 + random() * 60) * SECOND;
      const candidates = Array.from({ length: Math.floor(random() * 12) }, () =>
        candidate((random() * sessionEndUs) / SECOND, random(), random()),
      );
      const plan = planCameraTrack(candidates, sessionEndUs);
      const effects = generatedZoomEffects(plan, 0, 2);
      for (const effect of effects) {
        expect(effectProblem(effect)).toBeUndefined();
        expect(effect.range.startUs + effect.range.durationUs).toBeLessThanOrEqual(
          sessionEndUs + 1,
        );
      }
      // Zooms come in order and never overlap.
      for (let index = 1; index < plan.length; index += 1) {
        const previous = plan[index - 1];
        const zoom = plan[index];
        expect((zoom?.startUs ?? 0) >= (previous?.startUs ?? 0) + (previous?.durationUs ?? 0)).toBe(
          true,
        );
      }
      // Every click is inside a zoom, held there once the zoom has had its lead.
      for (const each of candidates) {
        const zoom = effects.find(
          (effect) =>
            each.timeUs >= effect.range.startUs &&
            each.timeUs <= effect.range.startUs + effect.range.durationUs,
        );
        expect(zoom).toBeDefined();
        const endUs = (zoom?.range.startUs ?? 0) + (zoom?.range.durationUs ?? 0);
        if (
          zoom !== undefined &&
          each.timeUs - zoom.range.startUs >= DEFAULT_CAMERA_PLAN.leadUs &&
          endUs - each.timeUs >= zoom.easeOutUs
        ) {
          expect(zoomProgress(zoom, each.timeUs)).toBe(1);
        }
      }
    }
  });
});

describe('rest focus', () => {
  /** A pointer that moves in steps of `samples` (seconds, x, y), with clicks. */
  const trackOf = (
    samples: readonly (readonly [number, number, number])[],
    clicks: PointerEvent[] = [],
  ) =>
    pointerTrackFromStream({
      coordinateSpace: 'capture',
      display: { width: 1920, height: 1080, dpiScale: 1 },
      events: [
        ...samples.map(([seconds, x, y]): PointerEvent => ({
          type: 'move',
          timeUs: asTimestampUs(Math.round(seconds * SECOND)),
          x,
          y,
        })),
        ...clicks,
      ].sort((first, second) => first.timeUs - second.timeUs),
    });

  it('focuses where the pointer stops somewhere new for a while', () => {
    const track = trackOf([
      [0, 0.1, 0.1],
      [0.2, 0.3, 0.3],
      [0.4, 0.6, 0.5],
      // Still, apart from a hand's tremor, for a second and a half.
      [0.9, 0.605, 0.502],
      [1.9, 0.6, 0.5],
      [2, 0.9, 0.9],
    ]);
    const candidates = restFocusCandidates(track, 3 * SECOND);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({ timeUs: 400_000, weight: 0.6 });
    expect(candidates[0]?.x).toBeCloseTo(0.6, 5);
    expect(candidates[0]?.y).toBeCloseTo(0.5, 5);
    expect(candidates[1]).toMatchObject({ timeUs: 2_000_000, weight: 0.6 });
    expect(candidates[1]?.x).toBeCloseTo(0.9, 5);
    expect(candidates[1]?.y).toBeCloseTo(0.9, 5);
  });

  it('leaves out short pauses, a start without moving, and rests a click already covers', () => {
    // A pause too short, then the end of the session.
    expect(
      restFocusCandidates(
        trackOf([
          [0, 0.1, 0.1],
          [0.5, 0.6, 0.5],
          [0.9, 0.2, 0.8],
        ]),
        1.2 * SECOND,
      ),
    ).toEqual([]);
    // Still from the start: nothing new to look at.
    expect(restFocusCandidates(trackOf([[0, 0.4, 0.4]]), 5 * SECOND)).toEqual([]);
    // A click during the rest is the focus there already.
    expect(
      restFocusCandidates(
        trackOf(
          [
            [0, 0.1, 0.1],
            [0.5, 0.6, 0.5],
            [2, 0.62, 0.5],
          ],
          [click(1, 0.6, 0.5)],
        ),
        2.5 * SECOND,
      ),
    ).toEqual([]);
  });
});

describe('the generated camera layer', () => {
  const plan = planCameraTrack([candidate(5, 0.25, 0.25)], 20 * SECOND);

  it('turns toward each action with 3D motion, and stays flat without it', () => {
    expect(turnToward({ x: 0.9, y: 0.5 }, 0)).toBeUndefined();
    // Right of centre: the right side comes nearer (a negative turn); low down: the bottom does.
    const right = turnToward({ x: 0.9, y: 0.5 }, 1);
    expect(right?.y).toBeLessThan(0);
    expect(right?.x).toBe(6);
    const low = turnToward({ x: 0.5, y: 0.9 }, 1);
    expect(low?.x).toBeGreaterThan(6);
    expect(low?.y).toBe(0);
    // Every angle stays well within a zoom's 30 degrees, and halves at half the motion.
    const corner = turnToward({ x: 0, y: 1 }, 1);
    expect(Math.abs(corner?.x ?? 99)).toBeLessThanOrEqual(30);
    expect(Math.abs(corner?.y ?? 99)).toBeLessThanOrEqual(30);
    expect(turnToward({ x: 0, y: 1 }, 0.5)?.y).toBeCloseTo((corner?.y ?? 0) / 2, 1);

    const [turned] = generatedZoomEffects(plan, 3 * SECOND, 2.5, 0.6);
    expect(turned?.poses[0]?.value.rotation).toEqual(turnToward({ x: 0.25, y: 0.25 }, 0.6));
    expect(turned === undefined ? 'missing' : effectProblem(turned)).toBeUndefined();
    const [flat] = generatedZoomEffects(plan, 3 * SECOND, 2.5);
    expect(flat?.poses[0]?.value).not.toHaveProperty('rotation');
  });

  it('moves to the media’s own time and leaves out what comes before it', () => {
    const [zoom] = generatedZoomEffects(plan, 3 * SECOND, 2.5);
    expect(zoom?.range).toEqual({ startUs: 1_000_000, durationUs: 2_500_000 });
    expect(zoom?.poses[0]).toEqual({
      timestampUs: 1_600_000,
      value: { anchor: { x: 0.25, y: 0.25 }, scale: 2.5 },
      easing: 'ease-in-out',
      hold: true,
    });
    // A segment file starting after the zoom ends gets none; one starting inside it, the rest.
    expect(generatedZoomEffects(plan, 7 * SECOND, 2)).toEqual([]);
    expect(generatedZoomEffects(plan, 5 * SECOND, 2)[0]?.range).toEqual({
      startUs: 0,
      durationUs: 1_500_000,
    });
  });

  it('lies under the clip’s own zooms, which ease from it and back', () => {
    const generated = generatedZoomEffects(plan, 0, 2);
    const manual: ZoomEffect = {
      id: asEffectId('manual'),
      kind: 'zoom',
      range: { startUs: asTimestampUs(5 * SECOND), durationUs: asDurationUs(2 * SECOND) },
      enabled: true,
      poses: [
        {
          timestampUs: asTimestampUs(5 * SECOND),
          value: { anchor: { x: 0.75, y: 0.75 }, scale: 3 },
          easing: 'linear',
        },
      ],
      easeInUs: 500_000,
      easeOutUs: 500_000,
      easing: 'linear',
    };
    const at = (seconds: number) =>
      cameraViewAt([manual], seconds * SECOND, cameraViewAt(generated, seconds * SECOND));
    // Before the manual zoom, the generated one shows; while it holds, the manual one.
    expect(at(4.8).scale).toBeCloseTo(2, 6);
    expect(at(4.8).centerX).toBeCloseTo(0.25, 6);
    expect(at(6).scale).toBeCloseTo(3, 6);
    expect(at(6).centerX).toBeCloseTo(0.75, 6);
    // As it begins, the camera is still where the generated zoom put it.
    expect(at(5)).toEqual(cameraViewAt(generated, 5 * SECOND));
    expect(at(10)).toEqual(FULL_FRAME);
  });
});
