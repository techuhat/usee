import type { PictureChange } from '@usee/domain';

/**
 * Where a recording's picture changes (Phase 6, "smarter focus"), read from
 * its decoded frames, never from keystrokes: each sampled frame is reduced to
 * the mean luma of a grid of cells, and a group of cells that changes from
 * one sample to the next is a change at that place. Changes seen within half
 * a second are read together, so typing, a character at a time, still makes
 * a line; a cell that keeps changing is an animation (a video, a spinner) and
 * is left out. The camera planner weighs what is left (`pictureFocusCandidates`).
 */

/** Frames are read this often: ten a second. */
export const PICTURE_SAMPLE_INTERVAL_US = 100_000;
export const PICTURE_GRID = Object.freeze({ columns: 32, rows: 18 });
/** Each frame is drawn this small to be read: four pixels a cell. */
export const PICTURE_READ_SIZE = Object.freeze({
  width: PICTURE_GRID.columns * 4,
  height: PICTURE_GRID.rows * 4,
});

export interface PictureChangeOptions {
  /** A cell has changed when its mean luma moves by more than this, 0-255. */
  readonly threshold: number;
  /** Changes this many samples apart are read together. */
  readonly windowSamples: number;
  /** A cell changing in this many of the last `historySamples` samples is animating. */
  readonly animationSamples: number;
  readonly historySamples: number;
  /** A change smaller than this many cells is noise, such as a caret blinking. */
  readonly minCells: number;
  /** Beyond this many changes a recording is all motion: no more are kept. */
  readonly maxChanges: number;
}

export const DEFAULT_PICTURE_CHANGE: PictureChangeOptions = Object.freeze({
  threshold: 6,
  windowSamples: 5,
  animationSamples: 14,
  historySamples: 20,
  minCells: 2,
  maxChanges: 50_000,
});

/** Mean luma (Rec. 709 weights, 0-255) of each cell of a grid laid over an RGBA image. */
export function cellLuma(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  columns: number = PICTURE_GRID.columns,
  rows: number = PICTURE_GRID.rows,
): Float32Array {
  const sums = new Float32Array(columns * rows);
  const counts = new Uint32Array(columns * rows);
  for (let y = 0; y < height; y += 1) {
    const row = Math.min(rows - 1, Math.floor((y * rows) / height));
    for (let x = 0; x < width; x += 1) {
      const cell = row * columns + Math.min(columns - 1, Math.floor((x * columns) / width));
      const at = (y * width + x) * 4;
      sums[cell] =
        (sums[cell] ?? 0) +
        0.2126 * (rgba[at] ?? 0) +
        0.7152 * (rgba[at + 1] ?? 0) +
        0.0722 * (rgba[at + 2] ?? 0);
      counts[cell] = (counts[cell] ?? 0) + 1;
    }
  }
  for (let cell = 0; cell < sums.length; cell += 1) {
    sums[cell] = (sums[cell] ?? 0) / Math.max(1, counts[cell] ?? 0);
  }
  return sums;
}

/** The groups of set cells that touch side to side, each a list of cell indices. */
function components(mask: Uint8Array, columns: number, rows: number): number[][] {
  const seen = new Uint8Array(mask.length);
  const groups: number[][] = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] !== 1 || seen[start] === 1) {
      continue;
    }
    const group: number[] = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const cell = stack.pop() ?? 0;
      group.push(cell);
      const column = cell % columns;
      const row = Math.floor(cell / columns);
      const neighbours = [
        column > 0 ? cell - 1 : -1,
        column < columns - 1 ? cell + 1 : -1,
        row > 0 ? cell - columns : -1,
        row < rows - 1 ? cell + columns : -1,
      ];
      for (const next of neighbours) {
        if (next >= 0 && mask[next] === 1 && seen[next] !== 1) {
          seen[next] = 1;
          stack.push(next);
        }
      }
    }
    groups.push(group);
  }
  return groups;
}

/** Reads a recording's sampled frames in time order and keeps where its picture changed. */
export class PictureChangeDetector {
  readonly #options: PictureChangeOptions;
  readonly #columns: number;
  readonly #rows: number;
  #previous: Float32Array | undefined;
  /** Which cells changed, for each of the last `historySamples` samples. */
  #history: Uint8Array[] = [];
  readonly #changes: PictureChange[] = [];

  constructor(
    options: PictureChangeOptions = DEFAULT_PICTURE_CHANGE,
    columns: number = PICTURE_GRID.columns,
    rows: number = PICTURE_GRID.rows,
  ) {
    this.#options = options;
    this.#columns = columns;
    this.#rows = rows;
  }

  get changes(): readonly PictureChange[] {
    return this.#changes;
  }

  push(timeUs: number, luma: Float32Array): void {
    const previous = this.#previous;
    this.#previous = luma;
    if (previous === undefined || this.#changes.length >= this.#options.maxChanges) {
      return;
    }
    const cells = this.#columns * this.#rows;
    const changed = new Uint8Array(cells);
    for (let cell = 0; cell < cells; cell += 1) {
      if (Math.abs((luma[cell] ?? 0) - (previous[cell] ?? 0)) > this.#options.threshold) {
        changed[cell] = 1;
      }
    }
    this.#history.push(changed);
    if (this.#history.length > this.#options.historySamples) {
      this.#history.shift();
    }
    // Recent changes, read together, less the cells that keep changing.
    const window = this.#history.slice(-this.#options.windowSamples);
    const mask = new Uint8Array(cells);
    for (let cell = 0; cell < cells; cell += 1) {
      const recent = window.some((sample) => sample[cell] === 1);
      const busy = this.#history.reduce((count, sample) => count + (sample[cell] ?? 0), 0);
      if (recent && busy < this.#options.animationSamples) {
        mask[cell] = 1;
      }
    }
    for (const group of components(mask, this.#columns, this.#rows)) {
      // Only a group that changed just now is a change now; the rest was already seen.
      if (group.length < this.#options.minCells || !group.some((cell) => changed[cell] === 1)) {
        continue;
      }
      const columnsOf = group.map((cell) => cell % this.#columns);
      const rowsOf = group.map((cell) => Math.floor(cell / this.#columns));
      const left = Math.min(...columnsOf);
      const right = Math.max(...columnsOf) + 1;
      const top = Math.min(...rowsOf);
      const bottom = Math.max(...rowsOf) + 1;
      this.#changes.push({
        timeUs,
        x: (left + right) / 2 / this.#columns,
        y: (top + bottom) / 2 / this.#rows,
        w: (right - left) / this.#columns,
        h: (bottom - top) / this.#rows,
      });
      if (this.#changes.length >= this.#options.maxChanges) {
        return;
      }
    }
  }
}
