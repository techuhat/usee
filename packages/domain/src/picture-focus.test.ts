import { describe, expect, it } from 'vitest';

import { pictureFocusCandidates, type PictureChange } from './picture-focus';

const change = (timeUs: number, x: number, y: number, w = 0.1, h = 0.1): PictureChange => ({
  timeUs,
  x,
  y,
  w,
  h,
});

describe('picture-change focus', () => {
  it('looks where a menu or dialog appears, below a click in weight', () => {
    expect(pictureFocusCandidates([change(2_000_000, 0.7, 0.3)])).toEqual([
      { timeUs: 2_000_000, x: 0.7, y: 0.3, weight: 0.5 },
    ]);
  });

  it('counts a place that keeps changing, as typing does, once', () => {
    const typing = [0, 1, 2, 3, 4, 5].map((step) =>
      change(1_000_000 + step * 400_000, 0.3 + step * 0.01, 0.6),
    );
    expect(pictureFocusCandidates(typing)).toHaveLength(1);
    // A pause longer than the window, and the same place is new again.
    expect(pictureFocusCandidates([...typing, change(6_000_000, 0.36, 0.6)])).toHaveLength(2);
  });

  it('leaves out a change over much of the frame: a scroll or another window', () => {
    expect(pictureFocusCandidates([change(1_000_000, 0.5, 0.5, 0.9, 0.8)])).toEqual([]);
  });

  it('takes changes in time order whatever order they come in', () => {
    const candidates = pictureFocusCandidates([
      change(3_000_000, 0.8, 0.8),
      change(1_000_000, 0.1, 0.1),
    ]);
    expect(candidates.map((candidate) => candidate.timeUs)).toEqual([1_000_000, 3_000_000]);
  });
});
