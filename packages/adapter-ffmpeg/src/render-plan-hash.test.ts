import { describe, expect, it } from 'vitest';

import { asProjectId, asTimestampUs } from '@usee/contracts';
import {
  DEFAULT_AUTO_ZOOM_SETTINGS,
  DEFAULT_CANVAS_STYLE,
  DEFAULT_CURSOR_SETTINGS,
  EXPORT_PRESETS,
  type RenderPlan,
} from '@usee/domain';

import { canonicalJson } from './canonical-json';
import { hashRenderPlan } from './render-plan-hash';

const plan: RenderPlan = {
  planVersion: 1,
  projectId: asProjectId('plan-test'),
  projectUpdatedAtUs: asTimestampUs(10),
  durationUs: 1_000_000,
  frameRate: { numerator: 30, denominator: 1 },
  preset: EXPORT_PRESETS['mp4-h264-1080p30'],
  assets: [],
  tracks: [],
  analysisRuns: [],
  canvas: DEFAULT_CANVAS_STYLE,
  cursor: DEFAULT_CURSOR_SETTINGS,
  autoZoom: DEFAULT_AUTO_ZOOM_SETTINGS,
};

describe('render plan hashing', () => {
  it('sorts object keys and omits optional undefined fields', () => {
    expect(canonicalJson({ z: 1, optional: undefined, a: { y: 2, x: 1 } })).toBe(
      '{"a":{"x":1,"y":2},"z":1}',
    );
  });

  it('hashes the same semantic plan deterministically and changes when intent changes', () => {
    expect(hashRenderPlan(plan)).toBe(hashRenderPlan({ ...plan }));
    expect(hashRenderPlan(plan)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRenderPlan({ ...plan, preset: EXPORT_PRESETS['mp4-h264-1080p60'] })).not.toBe(
      hashRenderPlan(plan),
    );
  });

  it('rejects values that are not valid JSON numbers', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow('non-finite number');
  });
});
