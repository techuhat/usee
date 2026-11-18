import type { CanvasStyleDto } from '@usee/contracts';
import { DEFAULT_CANVAS_STYLE } from '@usee/domain';

import { BACKGROUNDS } from '../editor/CanvasPanel';
import type { Swatch } from '../editor/ui';

/** No background: the recording fills the frame edge to edge, as it always has. */
export const NO_BACKGROUND: Swatch = {
  id: 'none',
  name: 'None',
  paint: 'linear-gradient(135deg, transparent 45%, #a2aac6 46% 54%, transparent 55%), #0b1020',
};

/** The backgrounds a new recording can start on: none, then shareable canvas looks. */
export const LOOK_SWATCHES: readonly Swatch[] = [
  NO_BACKGROUND,
  ...BACKGROUNDS.filter(
    (swatch) =>
      swatch.background.kind === 'gradient' || swatch.background.kind === 'blurred-source',
  ),
];

/** A framed picture: some room around it, rounded corners and a soft shadow. */
const FRAMED = {
  padding: 0.08,
  cornerRadius: 0.03,
  shadow: { opacity: 0.45, blur: 0.04, offsetY: 0.01 },
} as const;

/** The canvas a new recording starts with on the swatch `id`. */
export function canvasForLook(id: string): CanvasStyleDto {
  const swatch = BACKGROUNDS.find((candidate) => candidate.id === id);
  return swatch === undefined
    ? DEFAULT_CANVAS_STYLE
    : { ...DEFAULT_CANVAS_STYLE, ...FRAMED, background: swatch.background };
}

/** The swatch a canvas was made from, if it was. */
export function lookOf(canvas: CanvasStyleDto): string | undefined {
  if (canvas.padding === 0) {
    return NO_BACKGROUND.id;
  }
  const same = JSON.stringify(canvas.background);
  return BACKGROUNDS.find((swatch) => JSON.stringify(swatch.background) === same)?.id;
}
