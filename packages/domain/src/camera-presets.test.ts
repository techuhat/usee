import { describe, expect, it } from 'vitest';

import { asDurationUs, asEffectId, asTimestampUs } from '@usee/contracts';

import { CAMERA_PRESETS, presetKeyframes } from './camera-presets';
import { cameraViewAt } from './camera-view';
import { effectProblem } from './effect-rules';
import type { ZoomEffect } from './effects';

const SECOND = 1_000_000;

const zoom: ZoomEffect = {
  id: asEffectId('preset'),
  kind: 'zoom',
  range: { startUs: asTimestampUs(2 * SECOND), durationUs: asDurationUs(4 * SECOND) },
  enabled: true,
  poses: [
    {
      timestampUs: asTimestampUs(2 * SECOND),
      value: { anchor: { x: 0.3, y: 0.6 }, scale: 2.4 },
      easing: 'ease-in-out',
    },
  ],
  easeInUs: 500_000,
  easeOutUs: 500_000,
  easing: 'ease-in-out',
};

describe('3D presets', () => {
  it('gives every preset valid keyframes over the zoom’s body, looking where it looked', () => {
    for (const preset of CAMERA_PRESETS) {
      const poses = presetKeyframes(zoom, preset);
      expect(effectProblem({ ...zoom, poses })).toBeUndefined();
      expect(poses[0]?.timestampUs).toBe(2.5 * SECOND);
      expect(poses.at(-1)?.timestampUs).toBe(5.5 * SECOND);
      expect(
        poses.every((pose) => pose.value.anchor.x === 0.3 && pose.value.anchor.y === 0.6),
      ).toBe(true);
    }
  });

  it('pushes in to the zoom’s scale, flat, from a wider tilted view', () => {
    const [from, to] = presetKeyframes(zoom, 'push-in');
    expect(from?.value.scale).toBeLessThan(2.4);
    expect(from?.value.rotation?.x).toBeGreaterThan(0);
    expect(to?.value).toEqual({ anchor: { x: 0.3, y: 0.6 }, scale: 2.4 });
  });

  it('pulls out to a floating, turned card smaller than its place', () => {
    const poses = { ...zoom, poses: presetKeyframes(zoom, 'pull-out') };
    const end = cameraViewAt([poses], 5.5 * SECOND);
    expect(end.scale).toBeLessThan(1);
    expect(end.rotation?.y).toBeLessThan(0);
  });

  it('orbits through a middle keyframe without stopping there', () => {
    const poses = presetKeyframes(zoom, 'orbit');
    expect(poses).toHaveLength(3);
    expect(poses[1]?.hold).toBeUndefined();
    const orbit = { ...zoom, poses };
    const turnAt = (seconds: number) => cameraViewAt([orbit], seconds * SECOND).rotation?.y ?? 0;
    expect(turnAt(4.05) - turnAt(3.95)).toBeGreaterThan(0.5);
  });

  it('uses the whole span of a zoom whose ramps leave too little between them', () => {
    const short = { ...zoom, easeInUs: 1_950_000, easeOutUs: 1_950_000 };
    const poses = presetKeyframes(short, 'swing');
    expect(poses[0]?.timestampUs).toBe(2 * SECOND);
    expect(poses.at(-1)?.timestampUs).toBe(6 * SECOND);
    expect(effectProblem({ ...short, poses })).toBeUndefined();
  });
});
