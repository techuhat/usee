import { describe, expect, it } from 'vitest';

import { filmstripTiles, filmstripTimes, type FilmstripFrame } from './filmstrip';

const frames = [0, 2_000_000, 4_000_000, 6_000_000].map((timeUs): FilmstripFrame => ({
  timeUs,
  bitmap: {} as ImageBitmap,
}));

describe('the filmstrip', () => {
  it('reads every keyframe, or an even share of a long recording’s', () => {
    expect(filmstripTimes([0, 1, 2])).toEqual([0, 1, 2]);
    const thinned = filmstripTimes(
      Array.from({ length: 1_000 }, (_, index) => index),
      10,
    );
    expect(thinned).toEqual([0, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
  });

  it('lays tiles on the clip’s grid, each showing the picture at or before its middle', () => {
    // 10 000 source µs a pixel: a 100-px tile is a second.
    const tiles = filmstripTiles(frames, 0, 10_000, 0, 450, 100);
    expect(tiles).toEqual([
      { x: 0, frame: 0 },
      { x: 100, frame: 0 },
      { x: 200, frame: 1 },
      { x: 300, frame: 1 },
      { x: 400, frame: 2 },
    ]);
  });

  it('keeps tiles put as the timeline scrolls, and starts a trimmed clip at its source', () => {
    // Scrolled 150 px into the clip: the tile at 100 shows 50 px of itself.
    expect(filmstripTiles(frames, 0, 10_000, 150, 200, 100)[0]).toEqual({ x: -50, frame: 0 });
    // A clip trimmed to start 5 s into its source shows the picture from 4 s.
    expect(filmstripTiles(frames, 5_000_000, 10_000, 0, 100, 100)).toEqual([{ x: 0, frame: 2 }]);
  });

  it('draws nothing before a picture is read', () => {
    expect(filmstripTiles([], 0, 10_000, 0, 400, 100)).toEqual([]);
  });
});
