import type { Easing } from './keyframes';

/** Maps progress 0-1 through an easing curve (cubic in/out). */
export function ease(easing: Easing, progress: number): number {
  const t = Math.min(1, Math.max(0, progress));
  switch (easing) {
    case 'linear':
      return t;
    case 'ease-in':
      return t * t * t;
    case 'ease-out':
      return 1 - (1 - t) ** 3;
    case 'ease-in-out':
      return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
  }
}

export function lerp(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}
