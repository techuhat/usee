/** One picture of a recording for the timeline's filmstrip, at its keyframe's time. */
export interface FilmstripFrame {
  readonly timeUs: number;
  readonly bitmap: ImageBitmap;
}

/** A tile of a clip's filmstrip: where it is drawn and which picture fills it. */
export interface FilmstripTile {
  /** From the left of the drawn part, CSS pixels. */
  readonly x: number;
  readonly frame: number;
}

/** At most this many pictures of a recording: enough for an hour at one each six seconds. */
export const MAX_FILMSTRIP_FRAMES = 600;

/** The keyframe times to read, evenly thinned to at most `limit` of them. */
export function filmstripTimes(
  keyframes: readonly number[],
  limit = MAX_FILMSTRIP_FRAMES,
): number[] {
  if (keyframes.length <= limit) {
    return [...keyframes];
  }
  const step = keyframes.length / limit;
  return Array.from({ length: limit }, (_, index) => keyframes[Math.floor(index * step)] ?? 0);
}

/**
 * The tiles of the part of a clip on screen. Tiles sit on the clip's own
 * grid, so they stay put as the timeline scrolls; each shows the picture at
 * or before the source time at its middle, or the first one.
 */
export function filmstripTiles(
  frames: readonly FilmstripFrame[],
  /** Source time at the clip's left edge, and source microseconds per CSS pixel. */
  clipSourceStartUs: number,
  sourceUsPerPx: number,
  /** The drawn part: from this far into the clip, this wide. */
  offsetPx: number,
  widthPx: number,
  tileWidthPx: number,
): FilmstripTile[] {
  if (frames.length === 0 || tileWidthPx <= 0 || widthPx <= 0) {
    return [];
  }
  const tiles: FilmstripTile[] = [];
  const first = Math.floor(offsetPx / tileWidthPx);
  const last = Math.ceil((offsetPx + widthPx) / tileWidthPx);
  let frame = 0;
  for (let tile = first; tile < last; tile += 1) {
    const middleUs = clipSourceStartUs + (tile + 0.5) * tileWidthPx * sourceUsPerPx;
    while (frame + 1 < frames.length && (frames[frame + 1]?.timeUs ?? Infinity) <= middleUs) {
      frame += 1;
    }
    tiles.push({ x: tile * tileWidthPx - offsetPx, frame });
  }
  return tiles;
}
