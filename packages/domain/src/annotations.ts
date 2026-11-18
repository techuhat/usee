import type { AnnotationShape, Effect } from './effects';

/** How long an annotation takes to fade in, and out again (a quarter of a shorter span). */
export const ANNOTATION_FADE_US = 200_000;

/** An annotation showing at a moment, and how far it has faded in (0-1). */
export interface ActiveAnnotation {
  readonly shape: AnnotationShape;
  readonly opacity: number;
}

/** The clip's annotations showing at `sourceUs`, in the clip's order (ADR-011). */
export function activeAnnotationsAt(
  effects: readonly Effect[],
  sourceUs: number,
): readonly ActiveAnnotation[] {
  const showing: ActiveAnnotation[] = [];
  for (const effect of effects) {
    if (effect.kind !== 'annotation' || !effect.enabled) {
      continue;
    }
    const start = effect.range.startUs;
    const end = start + effect.range.durationUs;
    if (sourceUs < start || sourceUs >= end) {
      continue;
    }
    const fade = Math.min(ANNOTATION_FADE_US, effect.range.durationUs / 4);
    const opacity = fade > 0 ? Math.min(1, (sourceUs - start) / fade, (end - sourceUs) / fade) : 1;
    showing.push({ shape: effect.shape, opacity });
  }
  return showing;
}
