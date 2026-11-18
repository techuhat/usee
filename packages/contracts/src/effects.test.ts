import { describe, expect, it } from 'vitest';

import { effectSchema } from './effects';

function zoomWithPose(value: unknown) {
  return {
    id: 'zoom',
    kind: 'zoom',
    range: { startUs: 0, durationUs: 1_000_000 },
    enabled: true,
    poses: [{ timestampUs: 0, value, easing: 'linear' }],
    easeInUs: 0,
    easeOutUs: 0,
    easing: 'linear',
  };
}

describe('effect schema', () => {
  it('takes a zoom pose turned at most 30 degrees each way, or left flat', () => {
    const accepts = (value: unknown) => effectSchema.safeParse(zoomWithPose(value)).success;
    const anchor = { x: 0.5, y: 0.5 };
    expect(accepts({ anchor, scale: 2 })).toBe(true);
    expect(accepts({ anchor, scale: 2, rotation: { x: 30, y: -30, z: 12.5 } })).toBe(true);
    expect(accepts({ anchor, scale: 2, rotation: { x: 31, y: 0, z: 0 } })).toBe(false);
    expect(accepts({ anchor, scale: 2, rotation: { x: 0, y: 0 } })).toBe(false);
    // A flat pose leaves the rotation out rather than sending it empty.
    expect(accepts({ anchor, scale: 2, rotation: undefined })).toBe(false);
  });

  it('takes a pull-out to half the picture, a lens and a held keyframe (version 9)', () => {
    const anchor = { x: 0.5, y: 0.5 };
    const accepts = (value: unknown, extra: object = {}, keyframe: object = {}) =>
      effectSchema.safeParse({
        ...zoomWithPose(value),
        ...extra,
        poses: [{ timestampUs: 0, value, easing: 'linear', ...keyframe }],
      }).success;
    expect(accepts({ anchor, scale: 0.5 })).toBe(true);
    expect(accepts({ anchor, scale: 0.4 })).toBe(false);
    expect(accepts({ anchor, scale: 1.5 }, { lens: 15 })).toBe(true);
    expect(accepts({ anchor, scale: 1.5 }, { lens: 60 })).toBe(true);
    expect(accepts({ anchor, scale: 1.5 }, { lens: 75 })).toBe(false);
    expect(accepts({ anchor, scale: 1.5 }, {}, { hold: true })).toBe(true);
    expect(accepts({ anchor, scale: 1.5 }, {}, { hold: 'yes' })).toBe(false);
  });
});
