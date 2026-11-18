import type { FocusCandidate } from './focus';

/**
 * Where the picture changed (Phase 6, "smarter focus"): a region of the
 * recording that looked different from a moment before, as the editor found
 * it from the decoded frames, never from keystrokes. Time is the recording's
 * own; the region is normalized to its frame, `x` and `y` its centre.
 */
export interface PictureChange {
  readonly timeUs: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** What makes a change in the picture a place worth looking at. */
export interface PictureFocusOptions {
  /** Larger than this share of the frame is a scroll or a new window, not a place. */
  readonly maxArea: number;
  /** A change this close to the last focus, this soon after it, is the same place still changing. */
  readonly sameRadius: number;
  readonly sameWithinUs: number;
  /** Below a click (1) and a rest. */
  readonly weight: number;
}

export const DEFAULT_PICTURE_FOCUS: PictureFocusOptions = Object.freeze({
  maxArea: 0.4,
  sameRadius: 0.12,
  sameWithinUs: 1_500_000,
  weight: 0.5,
});

/**
 * Picture-change focus: each change small enough to be a place, such as a
 * menu or dialog opening or text being typed, is a candidate at its centre.
 * A change at the place the last one was, soon after it, is that place still
 * changing (typing goes on, a dialog animates in), so it adds nothing; one
 * covering much of the frame is a scroll or another window, so it is left out.
 */
export function pictureFocusCandidates(
  changes: readonly PictureChange[],
  options: PictureFocusOptions = DEFAULT_PICTURE_FOCUS,
): FocusCandidate[] {
  const candidates: FocusCandidate[] = [];
  let last: PictureChange | undefined;
  for (const change of [...changes].sort((first, second) => first.timeUs - second.timeUs)) {
    if (change.w * change.h > options.maxArea) {
      continue;
    }
    const near =
      last !== undefined &&
      change.timeUs - last.timeUs <= options.sameWithinUs &&
      Math.hypot(change.x - last.x, change.y - last.y) <= options.sameRadius;
    if (!near) {
      candidates.push({ timeUs: change.timeUs, x: change.x, y: change.y, weight: options.weight });
    }
    // The place keeps changing: what counts as soon after is measured from its latest change.
    last = change;
  }
  return candidates;
}
