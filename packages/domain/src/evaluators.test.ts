import { describe, expect, it } from 'vitest';

import { asDurationUs, asEffectId, asTimestampUs } from '@usee/contracts';

import { activeBlursAt, blurRegionsAt } from './blur-mask';
import { cameraViewAt, FULL_FRAME, projectPoint, zoomProgress } from './camera-view';
import { activeClicksAt, cursorAt, deriveCursorPath, pointerTrackFromStream } from './cursor-path';
import type { BlurEffect, ZoomEffect } from './effects';
import type { PointerEvent, PointerStream } from './interaction';

const SECOND = 1_000_000;
const range = (start: number, duration: number) => ({
  startUs: asTimestampUs(Math.round(start * SECOND)),
  durationUs: asDurationUs(Math.round(duration * SECOND)),
});

function zoom(
  start: number,
  duration: number,
  scale: number,
  anchor = { x: 0.5, y: 0.5 },
): ZoomEffect {
  return {
    id: asEffectId(`zoom-${Math.round(start * 1_000)}`),
    kind: 'zoom',
    range: range(start, duration),
    enabled: true,
    poses: [
      {
        timestampUs: asTimestampUs(Math.round(start * SECOND)),
        value: { anchor, scale },
        easing: 'linear',
      },
    ],
    easeInUs: 500_000,
    easeOutUs: 500_000,
    easing: 'linear',
  };
}

// A small deterministic generator, so a failing property reproduces exactly.
function randomFrom(seed: number) {
  let state = seed;
  return () => (state = (state * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
}

describe('camera view', () => {
  it('shows the whole frame outside zooms and holds the pose inside one', () => {
    const effects = [zoom(2, 4, 2, { x: 0.3, y: 0.6 })];
    expect(cameraViewAt(effects, 1 * SECOND)).toEqual(FULL_FRAME);
    expect(cameraViewAt(effects, 6 * SECOND)).toEqual(FULL_FRAME);
    const held = cameraViewAt(effects, 4 * SECOND);
    expect(held.scale).toBeCloseTo(2, 6);
    expect(held.centerX).toBeCloseTo(0.3, 6);
    expect(held.centerY).toBeCloseTo(0.6, 6);
    // The zoom target sits in the middle of the output while held.
    const target = projectPoint(held, 0.3, 0.6);
    expect(target.x).toBeCloseTo(0.5, 6);
    expect(target.y).toBeCloseTo(0.5, 6);
  });

  it('eases in and out smoothly', () => {
    const effect = zoom(0, 3, 3);
    const scales = [0, 0.1, 0.2, 0.3, 0.4, 0.5].map(
      (at) => cameraViewAt([effect], at * SECOND).scale,
    );
    for (let index = 1; index < scales.length; index += 1) {
      expect(scales[index] ?? 0).toBeGreaterThan(scales[index - 1] ?? 0);
    }
    expect(zoomProgress(effect, 2.75 * SECOND)).toBeCloseTo(0.5, 6);
    expect(zoomProgress(effect, 3 * SECOND)).toBe(0);
  });

  it('lets the zoom that began last win, and ignores disabled ones', () => {
    const early = zoom(0, 10, 2, { x: 0.2, y: 0.2 });
    const late = zoom(4, 2, 4, { x: 0.8, y: 0.8 });
    expect(cameraViewAt([late, early], 5 * SECOND).scale).toBeCloseTo(4, 6);
    expect(cameraViewAt([early, { ...late, enabled: false }], 5 * SECOND).scale).toBeCloseTo(2, 6);
  });

  it('moves from one zoom to the next and back without a jump', () => {
    const first = zoom(0, 8, 2, { x: 0.25, y: 0.25 });
    const second = zoom(3, 2, 3, { x: 0.75, y: 0.75 });
    const both = [second, first];
    // As the second begins, the camera is where the first put it.
    expect(cameraViewAt(both, 3 * SECOND)).toEqual(cameraViewAt([first], 3 * SECOND));
    // Held, the second decides.
    const held = cameraViewAt(both, 4 * SECOND);
    expect(held.scale).toBeCloseTo(3, 6);
    expect(held.centerX).toBeCloseTo(0.75, 6);
    // Halfway out, it is between its pose and the first zoom's, not the whole frame.
    const leaving = cameraViewAt(both, 4.75 * SECOND);
    expect(leaving.scale).toBeGreaterThan(2);
    expect(leaving.scale).toBeLessThan(3);
    expect(cameraViewAt(both, 5 * SECOND)).toEqual(cameraViewAt([first], 5 * SECOND));
  });

  it('moves the camera between a zoom’s keyframed poses', () => {
    const pose = (seconds: number, x: number, scale: number) => ({
      timestampUs: asTimestampUs(seconds * SECOND),
      value: { anchor: { x, y: 0.5 }, scale },
      easing: 'linear' as const,
    });
    const panning: ZoomEffect = { ...zoom(0, 6, 2), poses: [pose(1, 0.25, 2), pose(3, 0.75, 2)] };
    // The first pose holds until its keyframe, the camera pans to the next, which then holds.
    expect(cameraViewAt([panning], 1 * SECOND).centerX).toBeCloseTo(0.25, 6);
    expect(cameraViewAt([panning], 2 * SECOND).centerX).toBeCloseTo(0.5, 6);
    expect(cameraViewAt([panning], 2 * SECOND).scale).toBeCloseTo(2, 6);
    expect(cameraViewAt([panning], 4 * SECOND).centerX).toBeCloseTo(0.75, 6);
    // A keyframe can change the scale too: halfway is halfway in log space.
    const closing: ZoomEffect = { ...panning, poses: [pose(1, 0.5, 2), pose(3, 0.5, 8)] };
    expect(cameraViewAt([closing], 2 * SECOND).scale).toBeCloseTo(4, 6);
  });

  it('flows through a keyframe that does not hold, and stops at one that does', () => {
    const keyframe = (seconds: number, x: number, hold?: boolean) => ({
      timestampUs: asTimestampUs(seconds * SECOND),
      value: { anchor: { x, y: 0.5 }, scale: 4 },
      easing: 'ease-in-out' as const,
      ...(hold === undefined ? {} : { hold }),
    });
    const flowing: ZoomEffect = {
      ...zoom(0, 8, 4),
      poses: [keyframe(1, 0.2), keyframe(3, 0.5), keyframe(5, 0.8)],
    };
    const held: ZoomEffect = {
      ...flowing,
      poses: [keyframe(1, 0.2), keyframe(3, 0.5, true), keyframe(5, 0.8)],
    };
    const x = (effect: ZoomEffect, seconds: number) =>
      cameraViewAt([effect], Math.round(seconds * SECOND)).centerX;
    // Both pass through every keyframe exactly.
    for (const effect of [flowing, held]) {
      expect(x(effect, 1)).toBeCloseTo(0.2, 9);
      expect(x(effect, 3)).toBeCloseTo(0.5, 9);
      expect(x(effect, 5)).toBeCloseTo(0.8, 9);
    }
    // Flowing, the camera is still moving as it passes the middle keyframe ...
    expect(x(flowing, 3.05) - x(flowing, 2.95)).toBeGreaterThan(0.005);
    // ... holding, it comes to rest there, as every keyframe did before version 9.
    expect(x(held, 3.05) - x(held, 2.95)).toBeLessThan(0.0005);
    // It never goes past a keyframe on the way.
    for (let seconds = 1; seconds <= 5; seconds += 0.05) {
      expect(x(flowing, seconds)).toBeGreaterThanOrEqual(0.2 - 1e-9);
      expect(x(flowing, seconds)).toBeLessThanOrEqual(0.8 + 1e-9);
    }
    // A part that turns back at a keyframe stops there instead of overshooting it.
    const back: ZoomEffect = {
      ...flowing,
      poses: [keyframe(1, 0.2), keyframe(3, 0.6), keyframe(5, 0.3)],
    };
    for (let seconds = 1; seconds <= 5; seconds += 0.05) {
      expect(x(back, seconds)).toBeLessThanOrEqual(0.6 + 1e-9);
    }
  });

  it('turns smoothly through keyframes, scale and turn together', () => {
    const turned = (seconds: number, y: number, scale: number) => ({
      timestampUs: asTimestampUs(seconds * SECOND),
      value: { anchor: { x: 0.5, y: 0.5 }, scale, rotation: { x: 0, y, z: 0 } },
      easing: 'linear' as const,
    });
    const orbit: ZoomEffect = {
      ...zoom(0, 8, 2),
      poses: [turned(1, -20, 1.5), turned(3, 0, 2), turned(5, 20, 1.5)],
    };
    const at = (seconds: number) => cameraViewAt([orbit], Math.round(seconds * SECOND));
    expect(at(3).rotation?.y).toBeCloseTo(0, 9);
    expect(at(3.1).rotation?.y ?? 0).toBeGreaterThan(at(2.9).rotation?.y ?? 0);
    // The scale turns back at the middle keyframe, so it rests there.
    expect(Math.abs((at(3.02).scale ?? 0) - at(2.98).scale)).toBeLessThan(0.001);
  });

  it('sees through a zoom’s lens, easing to it from the view before', () => {
    const wide: ZoomEffect = { ...zoom(0, 4, 2), lens: 50 };
    expect(cameraViewAt([wide], 2 * SECOND).lens).toBe(50);
    // Halfway into the ramp, halfway from the default 30° lens.
    expect(cameraViewAt([wide], 0.25 * SECOND).lens).toBeCloseTo(40, 9);
    expect(cameraViewAt([zoom(0, 4, 2)], 2 * SECOND).lens).toBeUndefined();
    expect(cameraViewAt([wide], 5 * SECOND)).toEqual(FULL_FRAME);
  });

  it('never jumps between moments 10 ms apart', () => {
    const random = randomFrom(5);
    for (let run = 0; run < 100; run += 1) {
      // Valid zooms: each lasts at least as long as its two half-second ramps,
      // with one to three poses spread over it.
      const effects = [0, 1, 2].map(() => {
        const start = random() * 6;
        const duration = 1 + random() * 4;
        const count = 1 + Math.floor(random() * 3);
        const base = zoom(start, duration, 2);
        return {
          ...base,
          poses: Array.from({ length: count }, (_, index) => ({
            timestampUs: asTimestampUs(Math.round((start + (index * duration) / count) * SECOND)),
            value: { anchor: { x: random(), y: random() }, scale: 1 + random() * 7 },
            easing: 'linear' as const,
          })),
        };
      });
      let previous = cameraViewAt(effects, 0);
      let scaleStep = 0;
      let centreStep = 0;
      for (let at = 10_000; at <= 11 * SECOND; at += 10_000) {
        const view = cameraViewAt(effects, at);
        scaleStep = Math.max(scaleStep, Math.abs(Math.log(view.scale / previous.scale)));
        centreStep = Math.max(
          centreStep,
          Math.abs(view.centerX - previous.centerX),
          Math.abs(view.centerY - previous.centerY),
        );
        previous = view;
      }
      expect(scaleStep).toBeLessThan(0.35);
      expect(centreStep).toBeLessThan(0.25);
    }
  });

  it('never shows anything outside the frame', () => {
    const random = randomFrom(7);
    for (let run = 0; run < 500; run += 1) {
      const effects = [
        zoom(random() * 5, 0.5 + random() * 5, 1 + random() * 7, { x: random(), y: random() }),
        zoom(random() * 5, 0.5 + random() * 5, 1 + random() * 7, { x: random(), y: random() }),
      ];
      const view = cameraViewAt(effects, random() * 11 * SECOND);
      const half = 0.5 / view.scale;
      expect(view.scale).toBeGreaterThanOrEqual(1);
      expect(view.centerX - half).toBeGreaterThanOrEqual(-1e-9);
      expect(view.centerX + half).toBeLessThanOrEqual(1 + 1e-9);
      expect(view.centerY - half).toBeGreaterThanOrEqual(-1e-9);
      expect(view.centerY + half).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
});

describe('blur masks', () => {
  const blur: BlurEffect = {
    id: asEffectId('blur-1'),
    kind: 'blur',
    range: range(1, 4),
    enabled: true,
    intensity: 0.05,
    regions: [
      {
        timestampUs: asTimestampUs(2 * SECOND),
        value: [{ kind: 'rectangle', bounds: { x: 0, y: 0, width: 0.2, height: 0.2 } }],
        easing: 'linear',
      },
      {
        timestampUs: asTimestampUs(4 * SECOND),
        value: [{ kind: 'rectangle', bounds: { x: 0.4, y: 0.2, width: 0.2, height: 0.4 } }],
        easing: 'linear',
      },
    ],
  };

  it('moves the mask linearly between keyframes and holds it outside them', () => {
    expect(blurRegionsAt(blur, 0.5 * SECOND)).toEqual([]);
    expect(blurRegionsAt(blur, 1.5 * SECOND)).toEqual(blur.regions[0]?.value);
    expect(blurRegionsAt(blur, 3 * SECOND)).toEqual([
      { kind: 'rectangle', bounds: { x: 0.2, y: 0.1, width: 0.2, height: 0.30000000000000004 } },
    ]);
    expect(blurRegionsAt(blur, 4.5 * SECOND)).toEqual(blur.regions[1]?.value);
    expect(blurRegionsAt(blur, 5 * SECOND)).toEqual([]);
  });

  it('jumps when a region changes kind, and collects only blurs', () => {
    const changing: BlurEffect = {
      ...blur,
      regions: [
        blur.regions[0] ?? { timestampUs: asTimestampUs(0), value: [], easing: 'linear' },
        {
          timestampUs: asTimestampUs(4 * SECOND),
          value: [{ kind: 'ellipse', bounds: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 } }],
          easing: 'linear',
        },
      ],
    };
    expect(blurRegionsAt(changing, 3 * SECOND)).toEqual(blur.regions[0]?.value);
    expect(activeBlursAt([zoom(0, 9, 2), blur], 3 * SECOND)).toHaveLength(1);
    expect(activeBlursAt([{ ...blur, enabled: false }], 3 * SECOND)).toEqual([]);
  });
});

describe('cursor path', () => {
  function stream(events: PointerEvent[]): PointerStream {
    return {
      coordinateSpace: 'capture',
      display: { width: 1920, height: 1080, dpiScale: 1 },
      events,
    };
  }
  const move = (seconds: number, x: number, y: number): PointerEvent => ({
    type: 'move',
    timeUs: asTimestampUs(Math.round(seconds * SECOND)),
    x,
    y,
  });

  it('follows the raw path exactly without smoothing', () => {
    const track = pointerTrackFromStream(stream([move(0, 0.1, 0.1), move(1, 0.9, 0.5)]));
    const raw = deriveCursorPath(track, 0);
    expect(cursorAt(raw, 0.5 * SECOND)?.x).toBeCloseTo(0.5, 5);
    expect(cursorAt(raw, 0.5 * SECOND)?.y).toBeCloseTo(0.3, 5);
    expect(cursorAt(raw, 5 * SECOND)?.x).toBeCloseTo(0.9, 5); // holds after the last move
  });

  it('smooths a jump without overshooting, and lands on every click', () => {
    const events = [
      move(0, 0.1, 0.1),
      move(1, 0.1, 0.1),
      move(1.01, 0.9, 0.9),
      move(3, 0.9, 0.9),
      {
        type: 'down',
        timeUs: asTimestampUs(2 * SECOND),
        x: 0.9,
        y: 0.9,
        button: 'left',
      } as const,
    ];
    const path = deriveCursorPath(pointerTrackFromStream(stream(events)), 1);
    const shortlyAfter = cursorAt(path, 1.1 * SECOND)?.x ?? 0;
    expect(shortlyAfter).toBeGreaterThan(0.1);
    expect(shortlyAfter).toBeLessThan(0.9);
    expect(cursorAt(path, 2 * SECOND)?.x).toBeCloseTo(0.9, 4);
    for (const x of path.xs) {
      expect(x).toBeGreaterThanOrEqual(0.1 - 1e-6);
      expect(x).toBeLessThanOrEqual(0.9 + 1e-6);
    }
    const clicks = activeClicksAt(path, 2.2 * SECOND);
    expect(clicks).toHaveLength(1);
    expect(clicks[0]?.progress).toBeCloseTo(0.4444, 3);
    expect(activeClicksAt(path, 3 * SECOND)).toEqual([]);
  });

  // A steady sweep from left to right over two seconds, a move every 120th of a second.
  const sweep = Array.from({ length: 241 }, (_, step) =>
    move(step / 120, 0.1 + (0.4 * step) / 120, 0.5),
  );
  const click = (seconds: number, x: number, y: number): PointerEvent => ({
    type: 'down',
    timeUs: asTimestampUs(Math.round(seconds * SECOND)),
    x,
    y,
    button: 'left',
  });

  it('keeps up with the real pointer, never trailing behind it', () => {
    for (const smoothing of [0.5, 1]) {
      const path = deriveCursorPath(pointerTrackFromStream(stream(sweep)), smoothing);
      for (const seconds of [0.6, 1, 1.4]) {
        expect(cursorAt(path, seconds * SECOND)?.x).toBeCloseTo(0.1 + 0.4 * seconds, 3);
      }
    }
  });

  it('moves on through a click at the pointer’s own pace, without sticking to it', () => {
    const path = deriveCursorPath(
      pointerTrackFromStream(stream([...sweep, click(1, 0.5, 0.5)])),
      0.5,
    );
    expect(cursorAt(path, SECOND)?.x).toBeCloseTo(0.5, 4);
    for (let at = 0.8 * SECOND; at < 1.2 * SECOND; at += 10_000) {
      const step = (cursorAt(path, at + 10_000)?.x ?? 0) - (cursorAt(path, at)?.x ?? 0);
      expect(step).toBeCloseTo(0.004, 4); // 0.4 of the frame a second, over 10 ms
    }
  });

  it('lands exactly on a click just after a quick move, and does not move back', () => {
    const quick = Array.from({ length: 12 }, (_, step) =>
      move(1 + (step + 1) / 120, 0.1 + (0.8 * (step + 1)) / 12, 0.5),
    );
    const events = [move(0, 0.1, 0.5), move(1, 0.1, 0.5), ...quick, move(3, 0.9, 0.5)];
    for (const smoothing of [0.5, 1]) {
      const path = deriveCursorPath(
        pointerTrackFromStream(stream([...events, click(1.16, 0.9, 0.5)])),
        smoothing,
      );
      expect(cursorAt(path, 1.16 * SECOND)?.x).toBeCloseTo(0.9, 4);
      // Not by as much as a pixel of a 1920-pixel-wide frame.
      for (let index = 1; index < path.xs.length; index += 1) {
        expect(path.xs[index]).toBeGreaterThanOrEqual((path.xs[index - 1] ?? 0) - 1 / 1920);
      }
    }
  });

  it('knows the cursor shape and visibility at any moment', () => {
    const path = deriveCursorPath(
      pointerTrackFromStream(
        stream([
          move(0, 0.5, 0.5),
          { type: 'shape', timeUs: asTimestampUs(SECOND), shape: 'text' },
          { type: 'visibility', timeUs: asTimestampUs(2 * SECOND), visible: false },
          move(3, 0.5, 0.5),
        ]),
      ),
      0.5,
    );
    expect(cursorAt(path, 0.5 * SECOND)).toMatchObject({ shape: 'arrow', visible: true });
    expect(cursorAt(path, 1.5 * SECOND)).toMatchObject({ shape: 'text', visible: true });
    expect(cursorAt(path, 2.5 * SECOND)).toMatchObject({ shape: 'text', visible: false });
  });

  it('never strays more than a few pixels from the real pointer, however fast it moves', () => {
    const random = randomFrom(23);
    for (const [smoothing, dpiScale] of [
      [0.5, 1],
      [1, 1],
      [1, 2],
    ] as const) {
      const display = { width: 1920 * dpiScale, height: 1080 * dpiScale, dpiScale };
      // Flicks across the frame, a new place every quarter second, held a moment.
      const events: PointerEvent[] = [];
      for (let step = 0; step < 24; step += 1) {
        const x = random();
        const y = random();
        events.push(move(step / 4, x, y), move(step / 4 + 0.15, x, y));
      }
      const track = pointerTrackFromStream({ coordinateSpace: 'capture', display, events });
      const raw = deriveCursorPath(track, 0);
      const path = deriveCursorPath(track, smoothing);
      const strayPx = (4 + 12 * smoothing) * dpiScale;
      for (let index = 0; index < path.xs.length; index += 1) {
        const dx = ((path.xs[index] ?? 0) - (raw.xs[index] ?? 0)) * display.width;
        const dy = ((path.ys[index] ?? 0) - (raw.ys[index] ?? 0)) * display.height;
        expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(strayPx + 1e-3);
      }
    }
  });

  it('still smooths a hand’s tremor away', () => {
    const random = randomFrom(5);
    // Resting at the middle, trembling by up to 2 pixels either way, 120 times a second.
    const events = Array.from({ length: 240 }, (_, step) =>
      move(step / 120, 0.5 + ((random() - 0.5) * 4) / 1920, 0.5 + ((random() - 0.5) * 4) / 1080),
    );
    const track = pointerTrackFromStream(stream(events));
    const spread = (xs: Float32Array) => {
      const middle = xs.slice(30, 210);
      const mean = middle.reduce((sum, x) => sum + x, 0) / middle.length;
      return Math.sqrt(middle.reduce((sum, x) => sum + (x - mean) ** 2, 0) / middle.length);
    };
    expect(spread(deriveCursorPath(track, 0.5).xs)).toBeLessThan(
      spread(deriveCursorPath(track, 0).xs) / 3,
    );
  });

  it('stays inside the raw path’s range for any random walk', () => {
    const random = randomFrom(11);
    for (let run = 0; run < 20; run += 1) {
      const events: PointerEvent[] = [];
      for (let step = 0; step < 300; step += 1) {
        events.push(move(step / 120, random(), random()));
      }
      const path = deriveCursorPath(pointerTrackFromStream(stream(events)), random());
      for (let index = 0; index < path.xs.length; index += 1) {
        expect(path.xs[index]).toBeGreaterThanOrEqual(-1e-6);
        expect(path.xs[index]).toBeLessThanOrEqual(1 + 1e-6);
      }
    }
  });
});
