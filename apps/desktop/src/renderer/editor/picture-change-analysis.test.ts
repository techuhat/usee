import { describe, expect, it } from 'vitest';

import { cellLuma, PictureChangeDetector } from './picture-change-analysis';

const COLUMNS = 8;
const ROWS = 6;

/** A grid of cells, all `base` but those listed, which are `bright`. */
function grid(bright: readonly number[] = [], base = 40, value = 200): Float32Array {
  const cells = new Float32Array(COLUMNS * ROWS).fill(base);
  for (const cell of bright) cells[cell] = value;
  return cells;
}

const detector = () => new PictureChangeDetector(undefined, COLUMNS, ROWS);
const at = (column: number, row: number) => row * COLUMNS + column;

describe('reading where the picture changes', () => {
  it('averages each cell’s luma', () => {
    // A 4 x 2 image: the left half white, the right half black, read as 2 x 1 cells.
    const rgba = new Uint8ClampedArray(4 * 2 * 4);
    for (const pixel of [0, 1, 4, 5]) rgba.set([255, 255, 255, 255], pixel * 4);
    expect([...cellLuma(rgba, 4, 2, 2, 1)]).toEqual([255, 0]);
  });

  it('finds a dialog opening: the cells it covers, as a box', () => {
    const reader = detector();
    reader.push(0, grid());
    reader.push(100_000, grid([at(5, 1), at(6, 1), at(5, 2), at(6, 2)]));
    expect(reader.changes).toEqual([
      { timeUs: 100_000, x: 6 / COLUMNS, y: 2 / ROWS, w: 2 / COLUMNS, h: 2 / ROWS },
    ]);
  });

  it('reads typing a character at a time as a line', () => {
    const reader = detector();
    reader.push(0, grid());
    // One cell a sample, left to right: no single change is big enough, the line is.
    const typed: number[] = [];
    for (let step = 0; step < 4; step += 1) {
      typed.push(at(1 + step, 4));
      reader.push((step + 1) * 100_000, grid(typed));
    }
    expect(reader.changes.length).toBeGreaterThan(0);
    expect(reader.changes.at(-1)).toMatchObject({ y: 4.5 / ROWS, h: 1 / ROWS });
  });

  it('ignores a single blinking cell, such as a caret', () => {
    const reader = detector();
    for (let step = 0; step < 10; step += 1) {
      reader.push(step * 100_000, grid(step % 2 === 0 ? [] : [at(3, 3)]));
    }
    expect(reader.changes).toEqual([]);
  });

  it('stops looking at a place that keeps changing, such as a playing video', () => {
    const reader = detector();
    for (let step = 0; step < 40; step += 1) {
      const video = [at(0, 0), at(1, 0), at(0, 1), at(1, 1)];
      reader.push(step * 100_000, grid(video, 40, step % 2 === 0 ? 100 : 160));
    }
    // It counts while it starts, then no more.
    const late = reader.changes.filter((change) => change.timeUs > 2_000_000);
    expect(reader.changes.length).toBeGreaterThan(0);
    expect(late).toEqual([]);
  });
});
