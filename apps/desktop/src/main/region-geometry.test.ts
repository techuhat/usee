import { describe, expect, it } from 'vitest';

import { toDisplayRegion } from './region-geometry';

const display = { x: -1920, y: 0, width: 1920, height: 1080 };

describe('toDisplayRegion', () => {
  it('turns screen pixels into whole, even pixels of the display', () => {
    expect(toDisplayRegion({ x: -1820.4, y: 50.6, width: 641.2, height: 361 }, display)).toEqual({
      x: 100,
      y: 51,
      width: 640,
      height: 360,
    });
  });

  it('keeps only the part inside the display', () => {
    expect(toDisplayRegion({ x: -2000, y: -40, width: 400, height: 300 }, display)).toEqual({
      x: 0,
      y: 0,
      width: 320,
      height: 260,
    });
    expect(toDisplayRegion({ x: -100, y: 1000, width: 400, height: 300 }, display)).toEqual({
      x: 1820,
      y: 1000,
      width: 100,
      height: 80,
    });
  });

  it('refuses an area smaller than 64 x 64 pixels, or outside the display', () => {
    expect(toDisplayRegion({ x: -1900, y: 0, width: 63, height: 400 }, display)).toBeNull();
    expect(toDisplayRegion({ x: 10, y: 10, width: 400, height: 400 }, display)).toBeNull();
  });
});
