import type { TimestampUs } from '@usee/contracts';

import { lerp } from './easing';
import type { CursorShape, PointerButton, PointerStream } from './interaction';

/**
 * A pointer stream in columns: moves as typed arrays (a long recording has
 * hundreds of thousands), everything else as short lists. Times are session
 * microseconds, ascending.
 */
export interface PointerTrack {
  readonly display: { readonly width: number; readonly height: number; readonly dpiScale: number };
  readonly moveTimes: Float64Array;
  readonly moveXs: Float32Array;
  readonly moveYs: Float32Array;
  readonly clicks: readonly PointerClick[];
  readonly shapes: readonly { readonly timeUs: number; readonly shape: CursorShape }[];
  readonly visibility: readonly { readonly timeUs: number; readonly visible: boolean }[];
}

export interface PointerClick {
  readonly timeUs: number;
  readonly x: number;
  readonly y: number;
  readonly button: PointerButton;
}

export function pointerTrackFromStream(stream: PointerStream): PointerTrack {
  const moves = stream.events.filter((event) => event.type === 'move');
  const track: PointerTrack = {
    display: stream.display,
    moveTimes: Float64Array.from(moves, (event) => event.timeUs),
    moveXs: Float32Array.from(moves, (event) => event.x),
    moveYs: Float32Array.from(moves, (event) => event.y),
    clicks: stream.events.flatMap((event) =>
      event.type === 'down'
        ? [{ timeUs: event.timeUs, x: event.x, y: event.y, button: event.button }]
        : [],
    ),
    shapes: stream.events.flatMap((event) =>
      event.type === 'shape' ? [{ timeUs: event.timeUs, shape: event.shape }] : [],
    ),
    visibility: stream.events.flatMap((event) =>
      event.type === 'visibility' ? [{ timeUs: event.timeUs, visible: event.visible }] : [],
    ),
  };
  return track;
}

/** Samples per second of a derived path; between samples it is interpolated linearly. */
export const CURSOR_PATH_RATE_HZ = 120;
const SAMPLE_US = 1_000_000 / CURSOR_PATH_RATE_HZ;
/**
 * How widely full smoothing averages the path: the standard deviation of its
 * Gaussian weights. The average reaches as far ahead in time as behind, so
 * the cursor never trails the real one.
 */
const SMOOTHEST_SIGMA_US = 100_000;
/**
 * The cursor lands exactly on each click: it eases onto the real path this
 * long before, and after it eases off over this and the smoothing's own
 * reach, so it never pulls back toward a smoothed path still arriving.
 */
const CLICK_PULL_US = 150_000;
/**
 * The furthest the drawn cursor strays from where the pointer really was, in
 * logical pixels: this plus `CURSOR_STRAY_PER_SMOOTHING_PX` times the
 * smoothing (10 at the default 0.5). Smoothing takes out a hand's tremor,
 * which is smaller, but never lets the cursor trail a move or arrive late.
 */
const CURSOR_STRAY_BASE_PX = 4;
const CURSOR_STRAY_PER_SMOOTHING_PX = 12;

/**
 * The cursor as the editor draws it: the raw path averaged over the moments
 * around each one, as far ahead as behind, so it is smooth without lagging,
 * sampled at 120 Hz in session time. It lands exactly where each click
 * happened, so click effects sit under the cursor. Derived from the raw
 * stream and never stored over it (docs/module-boundaries.md, "Cursor engine").
 */
export interface CursorPath {
  /** The display the pointer was recorded on, which sets the cursor's size in the frame. */
  readonly display: PointerTrack['display'];
  readonly xs: Float32Array;
  readonly ys: Float32Array;
  readonly clicks: readonly PointerClick[];
  readonly shapes: PointerTrack['shapes'];
  readonly visibility: PointerTrack['visibility'];
}

/** The raw position at `timeUs`, interpolated between moves; `cursor` speeds up ascending lookups. */
function rawAt(track: PointerTrack, timeUs: number, cursor: { index: number }): [number, number] {
  const times = track.moveTimes;
  const count = times.length;
  if (count === 0) {
    return [0.5, 0.5];
  }
  while (cursor.index + 1 < count && (times[cursor.index + 1] ?? Infinity) <= timeUs) {
    cursor.index += 1;
  }
  const at = cursor.index;
  const t0 = times[at] ?? 0;
  const x0 = track.moveXs[at] ?? 0.5;
  const y0 = track.moveYs[at] ?? 0.5;
  if (timeUs <= t0 || at + 1 >= count) {
    return [x0, y0];
  }
  const t1 = times[at + 1] ?? t0;
  const share = t1 > t0 ? (timeUs - t0) / (t1 - t0) : 0;
  return [lerp(x0, track.moveXs[at + 1] ?? x0, share), lerp(y0, track.moveYs[at + 1] ?? y0, share)];
}

/**
 * `values` averaged with Gaussian weights `sigma` samples wide, as far ahead
 * as behind: a steady move stays exactly where it is, only its wobbles and
 * corners soften. Past either end, the end value holds.
 */
function gaussianAverage(values: Float32Array, sigma: number): Float32Array {
  const radius = Math.ceil(3 * sigma);
  const weights = Array.from({ length: radius + 1 }, (_, offset) =>
    Math.exp(-(offset * offset) / (2 * sigma * sigma)),
  );
  const total = weights.reduce((sum, weight, offset) => sum + (offset === 0 ? weight : 2 * weight));
  const last = values.length - 1;
  const averaged = new Float32Array(values.length);
  for (let index = 0; index <= last; index += 1) {
    let sum = values[index] ?? 0;
    for (let offset = 1; offset <= radius; offset += 1) {
      const before = values[Math.max(0, index - offset)] ?? 0;
      const after = values[Math.min(last, index + offset)] ?? 0;
      sum += (weights[offset] ?? 0) * (before + after);
    }
    averaged[index] = sum / total;
  }
  return averaged;
}

/**
 * How fully the drawn path follows the real one `distance` samples from a
 * click: all the way within a sample of it, easing smoothly to not at all at
 * `reach`, so the cursor neither jumps nor stalls on its way.
 */
function clickWeight(distance: number, reach: number): number {
  if (distance <= 1) {
    return 1;
  }
  return distance >= reach ? 0 : 0.5 * (1 + Math.cos((Math.PI * (distance - 1)) / (reach - 1)));
}

export function deriveCursorPath(track: PointerTrack, smoothing: number): CursorPath {
  const lastTime = track.moveTimes.length > 0 ? (track.moveTimes.at(-1) ?? 0) : 0;
  // Rounded up, so the path reaches the last move despite floating-point division.
  const count = Math.ceil(lastTime / SAMPLE_US) + 1;
  const rawXs = new Float32Array(count);
  const rawYs = new Float32Array(count);

  const lookup = { index: 0 };
  for (let sample = 0; sample < count; sample += 1) {
    const [x, y] = rawAt(track, sample * SAMPLE_US, lookup);
    rawXs[sample] = x;
    rawYs[sample] = y;
  }

  const share = Math.min(1, Math.max(0, smoothing));
  const sigma = (share * SMOOTHEST_SIGMA_US) / SAMPLE_US;
  const xs = sigma > 0 ? gaussianAverage(rawXs, sigma) : Float32Array.from(rawXs);
  const ys = sigma > 0 ? gaussianAverage(rawYs, sigma) : Float32Array.from(rawYs);

  // Never far from the real pointer: the smoothed point is pulled back to
  // within the stray of the raw one, so a fast move is followed as it was.
  if (sigma > 0) {
    const { width, height, dpiScale } = track.display;
    const strayPx = (CURSOR_STRAY_BASE_PX + CURSOR_STRAY_PER_SMOOTHING_PX * share) * dpiScale;
    for (let sample = 0; sample < count; sample += 1) {
      const rawX = rawXs[sample] ?? 0;
      const rawY = rawYs[sample] ?? 0;
      const dx = ((xs[sample] ?? 0) - rawX) * width;
      const dy = ((ys[sample] ?? 0) - rawY) * height;
      const distance = Math.hypot(dx, dy);
      if (distance > strayPx) {
        const keep = strayPx / distance;
        xs[sample] = rawX + (dx * keep) / width;
        ys[sample] = rawY + (dy * keep) / height;
      }
    }
  }

  // Ease the path onto the real one around each click, so it lands exactly there.
  const before = CLICK_PULL_US / SAMPLE_US;
  const after = before + 3 * sigma;
  for (const click of track.clicks) {
    const centre = click.timeUs / SAMPLE_US;
    const first = Math.max(0, Math.ceil(centre - before));
    const last = Math.min(count - 1, Math.floor(centre + after));
    for (let sample = first; sample <= last; sample += 1) {
      const distance = sample - centre;
      const weight = distance < 0 ? clickWeight(-distance, before) : clickWeight(distance, after);
      xs[sample] = lerp(xs[sample] ?? 0, rawXs[sample] ?? 0, weight);
      ys[sample] = lerp(ys[sample] ?? 0, rawYs[sample] ?? 0, weight);
    }
  }

  return {
    display: track.display,
    xs,
    ys,
    clicks: track.clicks,
    shapes: track.shapes,
    visibility: track.visibility,
  };
}

export interface CursorState {
  readonly x: number;
  readonly y: number;
  readonly shape: CursorShape;
  readonly visible: boolean;
}

function lastAtOrBefore<Entry extends { readonly timeUs: number }>(
  entries: readonly Entry[],
  timeUs: number,
): Entry | undefined {
  let found: Entry | undefined;
  for (const entry of entries) {
    if (entry.timeUs > timeUs) {
      break;
    }
    found = entry;
  }
  return found;
}

/** Where the cursor is at a moment of the session, or undefined when the path is empty. */
export function cursorPositionAt(
  path: CursorPath,
  sessionUs: number,
): { readonly x: number; readonly y: number } | undefined {
  const count = path.xs.length;
  if (count === 0) {
    return undefined;
  }
  const position = Math.min(count - 1, Math.max(0, sessionUs / SAMPLE_US));
  const at = Math.floor(position);
  const share = position - at;
  return {
    x: lerp(path.xs[at] ?? 0, path.xs[Math.min(at + 1, count - 1)] ?? 0, share),
    y: lerp(path.ys[at] ?? 0, path.ys[Math.min(at + 1, count - 1)] ?? 0, share),
  };
}

/** The cursor at a moment of the session, or undefined when the path is empty. */
export function cursorAt(
  path: CursorPath,
  sourceUs: number | TimestampUs,
): CursorState | undefined {
  const position = cursorPositionAt(path, sourceUs);
  if (position === undefined) {
    return undefined;
  }
  return {
    ...position,
    shape: lastAtOrBefore(path.shapes, sourceUs)?.shape ?? 'arrow',
    visible: lastAtOrBefore(path.visibility, sourceUs)?.visible ?? true,
  };
}

/** How long a click's effect lasts. */
export const CLICK_EFFECT_US = 450_000;

/** A click whose effect is showing: where the cursor was as it landed, and how far along it is. */
export interface ActiveClick {
  readonly x: number;
  readonly y: number;
  /** 0 as the button goes down, 1 as the effect ends. */
  readonly progress: number;
}

/** The clicks whose effects show at `sourceUs`, each where the cursor was at its click. */
export function activeClicksAt(path: CursorPath, sourceUs: number): readonly ActiveClick[] {
  const clicks: ActiveClick[] = [];
  for (const click of path.clicks) {
    const age = sourceUs - click.timeUs;
    if (age >= 0 && age < CLICK_EFFECT_US) {
      const cursor = cursorAt(path, click.timeUs);
      if (cursor !== undefined) {
        clicks.push({ x: cursor.x, y: cursor.y, progress: age / CLICK_EFFECT_US });
      }
    }
  }
  return clicks;
}
