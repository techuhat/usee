import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CANVAS_STYLE,
  canvasStyleProblem,
  outputAspect,
  pictureLayout,
  type CanvasStyle,
} from './canvas';

const WIDE = 16 / 9;
const style = (patch: Partial<CanvasStyle>): CanvasStyle => ({ ...DEFAULT_CANVAS_STYLE, ...patch });

describe('canvas style', () => {
  it('reads the output aspect from the preset, or keeps the source’s', () => {
    expect(outputAspect(style({ aspect: 'source' }), WIDE)).toBeCloseTo(WIDE, 6);
    expect(outputAspect(style({ aspect: '16:9' }), 1)).toBeCloseTo(WIDE, 6);
    expect(outputAspect(style({ aspect: '9:16' }), WIDE)).toBeCloseTo(9 / 16, 6);
    expect(outputAspect(style({ aspect: '1:1' }), WIDE)).toBe(1);
    expect(outputAspect(style({ aspect: '4:5' }), WIDE)).toBeCloseTo(0.8, 6);
  });

  it('fills the output when the picture keeps the source’s shape, no padding', () => {
    const layout = pictureLayout(DEFAULT_CANVAS_STYLE, WIDE, WIDE);
    expect(layout).toMatchObject({ x: 0, y: 0, width: 1, height: 1, radius: 0 });
  });

  it('letterboxes a wide picture on a square output, centred', () => {
    const layout = pictureLayout(style({ aspect: '1:1' }), WIDE, 1);
    expect(layout.width).toBeCloseTo(1, 6);
    expect(layout.height).toBeCloseTo(9 / 16, 6);
    expect(layout.y).toBeCloseTo((1 - 9 / 16) / 2, 6);
    expect(layout.x).toBeCloseTo(0, 6);
  });

  it('insets by the padding, fitting and centring the picture in the padded box', () => {
    // A wide picture on a tall output is limited by width, so its inset in x is the padding.
    const tall = pictureLayout(style({ aspect: '9:16', padding: 0.1 }), WIDE, 9 / 16);
    expect(tall.x).toBeCloseTo(0.1, 6);
    expect(tall.width).toBeCloseTo(0.8, 6);
    expect(tall.y).toBeCloseTo((1 - tall.height) / 2, 6);
    // With no padding the same picture reaches the output's edges.
    expect(pictureLayout(style({ aspect: '9:16' }), WIDE, 9 / 16).x).toBeCloseTo(0, 6);
  });

  it('scales the corner radius with the picture’s smaller side', () => {
    const square = pictureLayout(style({ aspect: '1:1', cornerRadius: 0.2 }), 1, 1);
    // On a square output a square picture fills it; its smaller side is the full width.
    expect(square.radius).toBeCloseTo(0.2, 6);
    const none = pictureLayout(style({ cornerRadius: 0 }), WIDE, WIDE);
    expect(none.radius).toBe(0);
  });

  it('accepts a bounded blurred recording backdrop', () => {
    expect(
      canvasStyleProblem(style({ background: { kind: 'blurred-source', blur: 0.04 } })),
    ).toBeUndefined();
    expect(canvasStyleProblem(style({ background: { kind: 'blurred-source', blur: 0.151 } }))).toBe(
      'backdrop blur must be 0.01-0.15',
    );
  });
});
