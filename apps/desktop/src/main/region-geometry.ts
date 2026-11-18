import type { HostRegion, Rectangle } from '@usee/contracts';

/** The smallest side of a region the recorder host accepts, in display pixels. */
const MIN_REGION_SIDE = 64;

/**
 * An area drawn on the picker, in physical screen pixels, as a region of the
 * display it was drawn over (ADR-009): the part inside the display, in whole
 * pixels, its sides even so H.264 encodes it unscaled. Null when that part is
 * smaller than the host accepts.
 */
export function toDisplayRegion(area: Rectangle, display: Rectangle): HostRegion | null {
  const clamp = (value: number, max: number) => Math.min(Math.max(Math.round(value), 0), max);
  const left = clamp(area.x - display.x, display.width);
  const top = clamp(area.y - display.y, display.height);
  const right = clamp(area.x + area.width - display.x, display.width);
  const bottom = clamp(area.y + area.height - display.y, display.height);
  const width = Math.floor((right - left) / 2) * 2;
  const height = Math.floor((bottom - top) / 2) * 2;
  return width >= MIN_REGION_SIDE && height >= MIN_REGION_SIDE
    ? { x: left, y: top, width, height }
    : null;
}
