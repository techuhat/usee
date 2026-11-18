import { CURSOR_BOX_PX, type CursorShape } from '@usee/domain';

/** Glyphs are drawn in a box this many units high: the domain's cursor box. */
export const GLYPH_BOX = CURSOR_BOX_PX;

interface GlyphShape {
  /** SVG path data, filled white with the nonzero rule and outlined dark. */
  readonly d: string;
  /** The point of the glyph that sits on the pointer's position. */
  readonly hotspot: { readonly x: number; readonly y: number };
  /** Radians, about the hotspot. */
  readonly rotation?: number;
}

const ARROW = 'M3 2 L3 19.5 L7.4 15.3 L10.4 21.8 L13.3 20.5 L10.4 14.1 L16.4 14.1 Z';
const RESIZE = 'M2 12 L7 7 V10 H17 V7 L22 12 L17 17 V14 H7 V17 Z';
// Clockwise outer circle and counter-clockwise inner one: a ring.
const RING =
  'M12 3 A9 9 0 0 1 12 21 A9 9 0 0 1 12 3 Z M12 6.5 A5.5 5.5 0 0 0 12 17.5 A5.5 5.5 0 0 0 12 6.5 Z';
const CENTRE = { x: 12, y: 12 };
const TIP = { x: 3, y: 2 };

const GLYPHS: Readonly<Record<CursorShape, GlyphShape>> = {
  arrow: { d: ARROW, hotspot: TIP },
  text: {
    d: 'M8 3 H11 L12 4 L13 3 H16 V4.6 H13.6 L12.8 5.4 V18.6 L13.6 19.4 H16 V21 H13 L12 20 L11 21 H8 V19.4 H10.4 L11.2 18.6 V5.4 L10.4 4.6 H8 Z',
    hotspot: CENTRE,
  },
  // A hand with the index finger up; the open strokes mark the fingers.
  pointer: {
    d:
      'M8 3.5 A1.5 1.5 0 0 1 11 3.5 V9.5 A1.5 1.5 0 0 1 14 9.5 V10.5 A1.5 1.5 0 0 1 17 10.5 ' +
      'V11.5 A1.5 1.5 0 0 1 20 11.5 V16 C20 19.3 17.8 22 14.5 22 H12.5 C10.3 22 9 21 7.8 19.6 ' +
      'L3.6 14.6 A1.4 1.4 0 0 1 5.8 12.9 L8 15 Z M11 9.5 V13 M14 10.5 V13.5 M17 11.5 V14',
    hotspot: { x: 9.5, y: 2 },
  },
  wait: { d: RING, hotspot: CENTRE },
  progress: {
    d: `${ARROW} M18.5 14.7 A3.8 3.8 0 0 1 18.5 22.3 A3.8 3.8 0 0 1 18.5 14.7 Z M18.5 16.6 A1.9 1.9 0 0 0 18.5 20.4 A1.9 1.9 0 0 0 18.5 16.6 Z`,
    hotspot: TIP,
  },
  crosshair: { d: 'M11 3 H13 V11 H21 V13 H13 V21 H11 V13 H3 V11 H11 Z', hotspot: CENTRE },
  'ew-resize': { d: RESIZE, hotspot: CENTRE },
  'ns-resize': { d: RESIZE, hotspot: CENTRE, rotation: Math.PI / 2 },
  'nwse-resize': { d: RESIZE, hotspot: CENTRE, rotation: Math.PI / 4 },
  'nesw-resize': { d: RESIZE, hotspot: CENTRE, rotation: -Math.PI / 4 },
  move: {
    d: 'M12 2 L16 6 H13 V11 H18 V8 L22 12 L18 16 V13 H13 V18 H16 L12 22 L8 18 H11 V13 H6 V16 L2 12 L6 8 V11 H11 V6 H8 Z',
    hotspot: CENTRE,
  },
  // A ring with a slash wound the same way as its outer circle, so it fills across the hole.
  'not-allowed': {
    d: 'M12 3 A9 9 0 0 1 12 21 A9 9 0 0 1 12 3 Z M12 5.5 A6.5 6.5 0 0 0 12 18.5 A6.5 6.5 0 0 0 12 5.5 Z M7.97 6.13 L17.87 16.03 L16.03 17.87 L6.13 7.97 Z',
    hotspot: CENTRE,
  },
  help: {
    d:
      `${ARROW} M17.1 13.4 C17.1 11.8 18.2 10.8 19.7 10.8 C21.2 10.8 22.3 11.8 22.3 13.1 ` +
      'C22.3 14.2 21.7 14.8 20.9 15.4 C20.4 15.8 20.3 16.1 20.3 16.7 V17.2 H18.9 V16.5 ' +
      'C18.9 15.6 19.2 15.1 19.9 14.6 C20.6 14.1 20.9 13.8 20.9 13.2 C20.9 12.6 20.4 12.2 19.7 12.2 ' +
      'C18.9 12.2 18.5 12.7 18.5 13.4 Z M18.9 18.2 H20.3 V19.6 H18.9 Z',
    hotspot: TIP,
  },
};

export interface CursorGlyph extends GlyphShape {
  readonly path: Path2D;
}

const built = new Map<CursorShape, CursorGlyph>();

/** The vector cursor drawn for a recorded cursor kind, its path built on first use. */
export function cursorGlyph(shape: CursorShape): CursorGlyph {
  let glyph = built.get(shape);
  if (glyph === undefined) {
    const definition = GLYPHS[shape];
    glyph = { ...definition, path: new Path2D(definition.d) };
    built.set(shape, glyph);
  }
  return glyph;
}
