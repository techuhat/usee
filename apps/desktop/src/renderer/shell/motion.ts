/**
 * Whether the app may animate on its own: off when Windows asks for less
 * motion (Settings, Accessibility, Visual effects, Animation effects).
 */
export const MOTION = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
