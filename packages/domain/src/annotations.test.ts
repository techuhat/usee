import { describe, expect, it } from 'vitest';

import { asDurationUs, asEffectId, asTimestampUs } from '@usee/contracts';

import { activeAnnotationsAt, ANNOTATION_FADE_US } from './annotations';
import { effectProblem } from './effect-rules';
import type { AnnotationEffect, AnnotationShape } from './effects';
import { composeFrame } from './frame-composition';

const SECOND = 1_000_000;

function annotation(
  shape: AnnotationShape,
  startSeconds = 1,
  seconds = 3,
  enabled = true,
): AnnotationEffect {
  return {
    id: asEffectId(`note-${shape.kind}`),
    kind: 'annotation',
    range: {
      startUs: asTimestampUs(startSeconds * SECOND),
      durationUs: asDurationUs(seconds * SECOND),
    },
    enabled,
    shape,
  };
}

const text: AnnotationShape = {
  kind: 'text',
  text: 'Click Save',
  at: { x: 0.5, y: 0.2 },
  size: 0.06,
  color: '#ffffff',
  background: true,
};
const arrow: AnnotationShape = {
  kind: 'arrow',
  from: { x: 0.3, y: 0.3 },
  to: { x: 0.5, y: 0.5 },
  lineWidth: 0.008,
  color: '#ff3b30',
};
const box: AnnotationShape = {
  kind: 'box',
  bounds: { x: 0.3, y: 0.3, width: 0.4, height: 0.3 },
  lineWidth: 0.008,
  color: '#34c759',
};

describe('annotations', () => {
  it('shows over their span, fading in and out at its edges', () => {
    const note = annotation(text);
    expect(activeAnnotationsAt([note], 0.5 * SECOND)).toEqual([]);
    expect(activeAnnotationsAt([note], 1 * SECOND)).toEqual([{ shape: text, opacity: 0 }]);
    expect(activeAnnotationsAt([note], 1 * SECOND + ANNOTATION_FADE_US / 2)).toEqual([
      { shape: text, opacity: 0.5 },
    ]);
    expect(activeAnnotationsAt([note], 2.5 * SECOND)).toEqual([{ shape: text, opacity: 1 }]);
    expect(activeAnnotationsAt([note], 4 * SECOND - ANNOTATION_FADE_US / 2)).toEqual([
      { shape: text, opacity: 0.5 },
    ]);
    expect(activeAnnotationsAt([note], 4 * SECOND)).toEqual([]);
  });

  it('fades a short one over a quarter of its span, and leaves one turned off out', () => {
    const short = annotation(arrow, 1, 0.4);
    expect(activeAnnotationsAt([short], 1.05 * SECOND)[0]?.opacity).toBeCloseTo(0.5, 6);
    expect(activeAnnotationsAt([annotation(box, 1, 3, false)], 2 * SECOND)).toEqual([]);
  });

  it('are listed by composeFrame in the order the clip holds them', () => {
    const frame = composeFrame([annotation(box), annotation(text)], 2 * SECOND);
    expect(frame.annotations.map((active) => active.shape.kind)).toEqual(['box', 'text']);
    expect(composeFrame([], 2 * SECOND).annotations).toEqual([]);
  });

  it('are refused when their words, sizes, colours or places are out of bounds', () => {
    expect(effectProblem(annotation(text))).toBeUndefined();
    expect(effectProblem(annotation(arrow))).toBeUndefined();
    expect(effectProblem(annotation(box))).toBeUndefined();
    expect(effectProblem(annotation({ ...text, text: '   ' }))).toBe('a text needs words');
    expect(effectProblem(annotation({ ...text, text: 'x'.repeat(121) }))).toBe(
      'a text is at most 120 characters',
    );
    expect(effectProblem(annotation({ ...text, size: 0.3 }))).toBe('text size must be 0.02-0.2');
    expect(effectProblem(annotation({ ...arrow, lineWidth: 0.05 }))).toBe(
      'a line must be 0.002-0.03 thick',
    );
    expect(effectProblem(annotation({ ...box, color: 'red' }))).toBe(
      'the annotation colour is not a colour',
    );
    expect(effectProblem(annotation({ ...arrow, to: { x: 1.5, y: 0.5 } }))).toBe(
      'an annotation must be on the frame',
    );
    expect(
      effectProblem(annotation({ ...box, bounds: { x: 0.9, y: 0.3, width: 0.2, height: 0.3 } })),
    ).toBe('an annotation must be on the frame');
    expect(effectProblem(annotation({ ...arrow, to: arrow.from }))).toBe('an arrow needs a length');
  });
});
