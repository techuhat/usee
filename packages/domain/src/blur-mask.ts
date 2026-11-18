import type { Rectangle } from '@usee/contracts';

import { ease, lerp } from './easing';
import type { BlurEffect, BlurRegion, Effect } from './effects';

export interface ActiveBlur {
  readonly regions: readonly BlurRegion[];
  readonly intensity: number;
}

function lerpRectangle(from: Rectangle, to: Rectangle, t: number): Rectangle {
  return {
    x: lerp(from.x, to.x, t),
    y: lerp(from.y, to.y, t),
    width: lerp(from.width, to.width, t),
    height: lerp(from.height, to.height, t),
  };
}

/** Moves each region toward its counterpart; a region whose kind changed jumps instead. */
function lerpRegions(
  from: readonly BlurRegion[],
  to: readonly BlurRegion[],
  t: number,
): readonly BlurRegion[] {
  if (from.length !== to.length) {
    return from;
  }
  return from.map((region, index) => {
    const target = to[index];
    if (target === undefined || target.kind !== region.kind) {
      return region;
    }
    if (region.kind === 'polygon' && target.kind === 'polygon') {
      return region.points.length === target.points.length
        ? {
            kind: 'polygon',
            points: region.points.map((point, at) => ({
              x: lerp(point.x, target.points[at]?.x ?? point.x, t),
              y: lerp(point.y, target.points[at]?.y ?? point.y, t),
            })),
          }
        : region;
    }
    if (region.kind !== 'polygon' && target.kind !== 'polygon') {
      return { kind: region.kind, bounds: lerpRectangle(region.bounds, target.bounds, t) };
    }
    return region;
  });
}

/** A blur's mask at `sourceUs`, between its keyframes; empty outside its range. */
export function blurRegionsAt(effect: BlurEffect, sourceUs: number): readonly BlurRegion[] {
  const start = effect.range.startUs;
  if (!effect.enabled || sourceUs < start || sourceUs >= start + effect.range.durationUs) {
    return [];
  }
  const keyframes = effect.regions;
  const next = keyframes.findIndex((keyframe) => keyframe.timestampUs > sourceUs);
  if (next === 0) {
    return keyframes[0]?.value ?? [];
  }
  if (next === -1) {
    return keyframes.at(-1)?.value ?? [];
  }
  const from = keyframes[next - 1];
  const to = keyframes[next];
  if (from === undefined || to === undefined) {
    return [];
  }
  const span = to.timestampUs - from.timestampUs;
  const progress = span > 0 ? ease(from.easing, (sourceUs - from.timestampUs) / span) : 1;
  return lerpRegions(from.value, to.value, progress);
}

/** Every blur showing at `sourceUs`, in the clip's effect order. */
export function activeBlursAt(effects: readonly Effect[], sourceUs: number): readonly ActiveBlur[] {
  const blurs: ActiveBlur[] = [];
  for (const effect of effects) {
    if (effect.kind !== 'blur') {
      continue;
    }
    const regions = blurRegionsAt(effect, sourceUs);
    if (regions.length > 0) {
      blurs.push({ regions, intensity: effect.intensity });
    }
  }
  return blurs;
}
