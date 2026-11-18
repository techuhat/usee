import { describe, expect, it } from 'vitest';

import { DEFAULT_CANVAS_STYLE } from './canvas';
import { exportDimensions, EXPORT_PRESETS } from './export';

describe('exportDimensions', () => {
  const preset = EXPORT_PRESETS['mp4-h264-1080p30'];

  it('keeps the preset dimensions when the project canvas matches them', () => {
    expect(exportDimensions(preset, DEFAULT_CANVAS_STYLE, 16 / 9)).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it('fits portrait and square canvases inside the preset bounds', () => {
    expect(exportDimensions(preset, { ...DEFAULT_CANVAS_STYLE, aspect: '9:16' }, 16 / 9)).toEqual({
      width: 608,
      height: 1080,
    });
    expect(exportDimensions(preset, { ...DEFAULT_CANVAS_STYLE, aspect: '1:1' }, 16 / 9)).toEqual({
      width: 1080,
      height: 1080,
    });
  });

  it('returns even dimensions for H.264 chroma subsampling', () => {
    const size = exportDimensions(preset, DEFAULT_CANVAS_STYLE, 1.6);
    expect(size.width % 2).toBe(0);
    expect(size.height % 2).toBe(0);
    expect(size.width).toBeLessThanOrEqual(preset.dimensions.width);
    expect(size.height).toBeLessThanOrEqual(preset.dimensions.height);
  });
});
