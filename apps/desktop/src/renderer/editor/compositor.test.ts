import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FULL_FRAME, type FrameComposition } from '@usee/domain';

import {
  drawFrame,
  motionBlurPx,
  outputCanvasSize,
  paintCanvas,
  paintShadow,
  tracePicture,
} from './compositor';

type Call = readonly [string, ...unknown[]];

/** A 2D context that records what is drawn: each method call, and each property set as `name=`. */
function recordingContext(width: number, height: number) {
  const calls: Call[] = [];
  const target: Record<string | symbol, unknown> = { canvas: { width, height } };
  const context = new Proxy(target, {
    get: (object, key) =>
      key in object
        ? object[key]
        : (...args: unknown[]) => {
            calls.push([String(key), ...args]);
            if (key === 'createLinearGradient' || key === 'createRadialGradient') {
              return { addColorStop: () => {} };
            }
            if (key === 'measureText') {
              return { width: String(args[0]).length * 20 };
            }
            return undefined;
          },
    set: (_object, key, value) => {
      calls.push([`${String(key)}=`, value]);
      return true;
    },
  });
  return { context: context as unknown as CanvasRenderingContext2D, calls };
}

const source = {} as CanvasImageSource;
const SOURCE = { width: 1280, height: 720 };
const still: FrameComposition = {
  camera: FULL_FRAME,
  blurs: [],
  annotations: [],
  cursor: undefined,
  clicks: [],
  clickEffect: 'ripple',
  cursorHeight: 0.05,
  cursorColor: '#ffffff',
  spotlight: 0,
  cameraMotion: 0,
};

const named = (calls: readonly Call[], name: string) => calls.filter((call) => call[0] === name);

/** Each call's numbers, to within floating-point error. */
function expectCall(calls: readonly Call[], expected: readonly (readonly number[])[]): void {
  expect(calls).toHaveLength(expected.length);
  for (const [index, numbers] of expected.entries()) {
    for (const [at, value] of numbers.entries()) {
      expect(calls[index]?.[at + 1]).toBeCloseTo(value, 6);
    }
  }
}

const SOLID = {
  aspect: 'source',
  background: { kind: 'solid', color: '#112233' },
  padding: 0,
  cornerRadius: 0,
  shadow: { opacity: 0, blur: 0.04, offsetY: 0.01 },
} as const;

beforeEach(() => {
  vi.stubGlobal(
    'Path2D',
    class {
      constructor(readonly d: string) {}
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('drawFrame', () => {
  it('draws the whole source over the canvas without a zoom', () => {
    const { context, calls } = recordingContext(640, 360);
    drawFrame(context, source, SOURCE, still);
    expect(named(calls, 'drawImage')).toEqual([
      ['drawImage', source, 0, 0, 1280, 720, 0, 0, 640, 360],
    ]);
  });

  it('crops to the camera’s view', () => {
    const { context, calls } = recordingContext(640, 360);
    drawFrame(context, source, SOURCE, {
      ...still,
      camera: { scale: 2, centerX: 0.75, centerY: 0.5 },
    });
    expect(named(calls, 'drawImage')).toEqual([
      ['drawImage', source, 640, 180, 640, 360, 0, 0, 640, 360],
    ]);
  });

  it('blurs a region where it lands, with a radius that zooms', () => {
    const { context, calls } = recordingContext(640, 360);
    drawFrame(context, source, SOURCE, {
      ...still,
      camera: { scale: 2, centerX: 0.5, centerY: 0.5 },
      blurs: [
        {
          intensity: 0.01,
          regions: [{ kind: 'rectangle', bounds: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } }],
        },
      ],
    });
    // 1 % of the frame height, at twice the frame's 360 pixels.
    expect(calls).toContainEqual(['filter=', 'blur(7.2px)']);
    // The region, traced in source units under the camera.
    expect(named(calls, 'rect')).toEqual([['rect', 0.4, 0.4, 0.2, 0.2]]);
    expect(calls).toContainEqual(['setTransform', 1280, 0, 0, 720, -320, -180]);
    // The patch reaches three radii past the region: 0.016875 of the frame's width, 0.03 of its height.
    const patch = named(calls, 'drawImage')[1] ?? [];
    expect(patch.slice(2).map((value) => Number(value).toFixed(2))).toEqual([
      '490.40',
      '266.40',
      '299.20',
      '187.20',
      '170.40',
      '86.40',
      '299.20',
      '187.20',
    ]);
  });

  it('writes a text annotation where it was put, sized with the zoom, on its label', () => {
    const { context, calls } = recordingContext(640, 360);
    drawFrame(context, source, SOURCE, {
      ...still,
      camera: { scale: 2, centerX: 0.5, centerY: 0.5 },
      annotations: [
        {
          shape: {
            kind: 'text',
            text: 'Save',
            at: { x: 0.5, y: 0.375 },
            size: 0.05,
            color: '#ffffff',
            background: true,
          },
          opacity: 1,
        },
      ],
    });
    // At 2x on a 360 px canvas the frame is 720 px high: the text is 36 px, a quarter of the way down.
    expect(calls).toContainEqual(['font=', expect.stringMatching(/^600 36px /)]);
    expect(named(calls, 'fillText')).toEqual([['fillText', 'Save', 320, 90]]);
    // A dark label behind white words: the 80 px measured, padded on each side.
    expectCall(named(calls, 'roundRect'), [
      [320 - 40 - 14.4, 90 - 18 - 7.92, 80 + 28.8, 36 + 15.84, 10.8],
    ]);
    expect(calls).toContainEqual(['fillStyle=', 'rgba(17, 20, 32, 0.82)']);
  });

  it('draws an arrow to its point and a box round its bounds, faded as they fade', () => {
    const { context, calls } = recordingContext(1280, 720);
    drawFrame(context, source, SOURCE, {
      ...still,
      annotations: [
        {
          shape: {
            kind: 'arrow',
            from: { x: 0.25, y: 0.25 },
            to: { x: 0.5, y: 0.25 },
            lineWidth: 0.01,
            color: '#ff3b30',
          },
          opacity: 1,
        },
        {
          shape: {
            kind: 'box',
            bounds: { x: 0.25, y: 0.5, width: 0.5, height: 0.25 },
            lineWidth: 0.01,
            color: '#34c759',
          },
          opacity: 0.5,
        },
      ],
    });
    // The shaft stops short of the point; the head, a filled triangle, ends on it.
    expect(named(calls, 'moveTo')[0]).toEqual(['moveTo', 320, 180]);
    expect(calls).toContainEqual(['moveTo', 640, 180]);
    expectCall(named(calls, 'roundRect'), [[320, 360, 640, 180, 10.8]]);
    expect(named(calls, 'globalAlpha=')).toEqual([
      ['globalAlpha=', 1],
      ['globalAlpha=', 0.5],
    ]);
    expect(calls).toContainEqual(['strokeStyle=', '#34c759']);
  });

  it('draws annotations under the cursor, which stays on top', () => {
    const { context, calls } = recordingContext(640, 360);
    drawFrame(context, source, SOURCE, {
      ...still,
      cursor: { x: 0.5, y: 0.5, shape: 'arrow' },
      annotations: [
        {
          shape: {
            kind: 'text',
            text: 'Here',
            at: { x: 0.5, y: 0.5 },
            size: 0.05,
            color: '#111111',
            background: false,
          },
          opacity: 1,
        },
      ],
    });
    const order = calls.map((call) => call[0]);
    expect(order.indexOf('fillText')).toBeLessThan(order.lastIndexOf('fill'));
  });

  it('puts the cursor’s hotspot on the pointer, scaled with the zoom', () => {
    const { context, calls } = recordingContext(640, 360);
    drawFrame(context, source, SOURCE, {
      ...still,
      camera: { scale: 2, centerX: 0.5, centerY: 0.5 },
      cursor: { x: 0.5, y: 0.5, shape: 'arrow' },
    });
    // The centre of the view is the centre of the canvas; the box is 5 % of 720 pixels.
    expect(named(calls, 'translate')).toEqual([
      ['translate', 320, 180],
      ['translate', -3, -2],
    ]);
    expect(named(calls, 'scale')).toEqual([['scale', 1.5, 1.5]]);
    expect(named(calls, 'fill')).toHaveLength(1);
  });

  it('grows and fades each click ripple', () => {
    const ripple = (progress: number) => {
      const { context, calls } = recordingContext(640, 360);
      drawFrame(context, source, SOURCE, { ...still, clicks: [{ x: 0.5, y: 0.5, progress }] });
      const arc = named(calls, 'arc')[0] ?? [];
      return { radius: Number(arc[3]), fill: calls.find((call) => call[0] === 'fillStyle=')?.[1] };
    };
    const start = ripple(0);
    const end = ripple(0.9);
    expect(start.radius).toBeCloseTo(0.05 * 360 * 0.9 * 0.3, 6);
    expect(end.radius).toBeGreaterThan(start.radius);
    expect(start.fill).toBe('rgba(0, 0, 0, 0.22)');
  });

  it('draws each kind of click effect its own way', () => {
    const draw = (clickEffect: FrameComposition['clickEffect'], progress: number) => {
      const { context, calls } = recordingContext(640, 360);
      drawFrame(context, source, SOURCE, {
        ...still,
        camera: { scale: 2, centerX: 0.5, centerY: 0.5 },
        cursor: { x: 0.5, y: 0.5, shape: 'arrow' },
        clicks: [{ x: 0.5, y: 0.5, progress }],
        clickEffect,
      });
      const arc = named(calls, 'arc')[0];
      return {
        radius: arc === undefined ? undefined : Number(arc[3]),
        fills: named(calls, 'fillStyle=').map((call) => String(call[1])),
        scale: named(calls, 'scale')[0]?.[1],
      };
    };
    // A pulse: a yellow dot that grows and fades.
    const pulse = [draw('pulse', 0.1), draw('pulse', 0.8)];
    expect(pulse[0]?.fills[0]).toMatch(/^rgba\(255, 200, 40, /);
    expect(pulse[1]?.radius).toBeGreaterThan(pulse[0]?.radius ?? Infinity);
    // A ring: it closes in on the point.
    expect(draw('ring', 0.8).radius).toBeLessThan(draw('ring', 0.1).radius ?? 0);
    // A bounce: no mark, the cursor pressed in at first and its own size again at the end.
    expect(draw('bounce', 0.2).radius).toBeUndefined();
    expect(draw('bounce', 0.2).scale).toBeCloseTo(1.5 * 0.78, 6);
    expect(draw('bounce', 1).scale).toBeCloseTo(1.5, 2);
    // None: nothing at all, the cursor as it is.
    expect(draw('none', 0.2)).toMatchObject({ radius: undefined, scale: 1.5 });
  });
});

describe('the styled canvas', () => {
  it('sizes the output canvas to the chosen aspect', () => {
    expect(outputCanvasSize(SOLID, SOURCE)).toEqual({ width: 1280, height: 720 });
    expect(outputCanvasSize({ ...SOLID, aspect: '1:1' }, SOURCE)).toEqual({
      width: 720,
      height: 720,
    });
    expect(outputCanvasSize({ ...SOLID, aspect: '9:16' }, SOURCE)).toEqual({
      width: 405,
      height: 720,
    });
  });

  it('fills a solid background and places the picture over the whole canvas', () => {
    const { context, calls } = recordingContext(1280, 720);
    const rect = paintCanvas(context, SOLID, SOURCE);
    expect(calls).toContainEqual(['fillStyle=', '#112233']);
    expect(named(calls, 'fillRect')).toContainEqual(['fillRect', 0, 0, 1280, 720]);
    expect(rect).toMatchObject({ x: 0, y: 0, w: 1280, h: 720, radius: 0 });
  });

  it('insets the picture by the padding and rounds its corners', () => {
    const { context } = recordingContext(1280, 720);
    const rect = paintCanvas(context, { ...SOLID, padding: 0.1, cornerRadius: 0.25 }, SOURCE);
    // On a source-shaped output the picture is height-limited; the inset in y is the padding.
    expect(rect.y).toBeCloseTo(0.1 * 720, 3);
    expect(rect.h).toBeCloseTo(0.8 * 720, 3);
    expect(rect.radius).toBeGreaterThan(0);
  });

  it('paints a gradient background from a linear gradient', () => {
    const { context, calls } = recordingContext(1280, 720);
    paintCanvas(
      context,
      { ...SOLID, background: { kind: 'gradient', from: '#000000', to: '#ffffff', angle: 90 } },
      SOURCE,
    );
    expect(named(calls, 'createLinearGradient')).toHaveLength(1);
  });

  it('covers and blurs the source behind a blurred recording backdrop', () => {
    class BackgroundBitmap {
      readonly width = 1280;
      readonly height = 720;
    }
    vi.stubGlobal('ImageBitmap', BackgroundBitmap);
    const background = new BackgroundBitmap() as unknown as CanvasImageSource;
    const { context, calls } = recordingContext(1280, 720);
    paintCanvas(
      context,
      { ...SOLID, background: { kind: 'blurred-source', blur: 0.04 } },
      SOURCE,
      background,
    );
    expect(calls).toContainEqual(['filter=', 'blur(28.8px)']);
    const draws = named(calls, 'drawImage');
    expect(draws).toHaveLength(1);
    expect(draws[0]?.[1]).toBe(background);
    // Enlarged by 1 + 6 x blur about the centre, so the blur's soft edge falls outside.
    for (const [index, expected] of [-153.6, -86.4, 1587.2, 892.8].entries()) {
      expect(draws[0]?.[index + 2]).toBeCloseTo(expected, 6);
    }
  });

  it('covers the canvas with a decoded video frame, whose size is its display size', () => {
    // What preview and export hand over: a VideoFrame has no videoWidth or videoHeight.
    class DecodedFrame {
      readonly displayWidth = 1920;
      readonly displayHeight = 1080;
    }
    vi.stubGlobal('VideoFrame', DecodedFrame);
    const frame = new DecodedFrame() as unknown as CanvasImageSource;
    const { context, calls } = recordingContext(1280, 720);
    paintCanvas(
      context,
      { ...SOLID, background: { kind: 'blurred-source', blur: 0.05 } },
      SOURCE,
      frame,
    );
    const draw = named(calls, 'drawImage')[0];
    expect(draw?.[1]).toBe(frame);
    for (const [index, expected] of [-192, -108, 1664, 936].entries()) {
      expect(draw?.[index + 2]).toBeCloseTo(expected, 6);
    }
  });

  it('keeps the recording out of an image background, which waits for its own picture', () => {
    class DecodedFrame {
      readonly displayWidth = 1920;
      readonly displayHeight = 1080;
    }
    vi.stubGlobal('VideoFrame', DecodedFrame);
    const { context, calls } = recordingContext(1280, 720);
    paintCanvas(
      context,
      { ...SOLID, background: { kind: 'image', assetId: 'backdrop' } },
      SOURCE,
      new DecodedFrame() as unknown as CanvasImageSource,
    );
    expect(named(calls, 'drawImage')).toEqual([]);
  });

  it('shadows the picture only when the style has a shadow, under the shape traced', () => {
    const { context, calls } = recordingContext(1280, 720);
    const rect = paintCanvas(context, SOLID, SOURCE);
    paintShadow(context, SOLID, () => tracePicture(context, rect));
    expect(named(calls, 'fill')).toHaveLength(0);
    const shadowed = { ...SOLID, shadow: { opacity: 0.5, blur: 0.04, offsetY: 0.01 } };
    paintShadow(context, shadowed, () => tracePicture(context, rect));
    expect(calls).toContainEqual(['shadowColor=', 'rgba(0, 0, 0, 0.5)']);
    expect(named(calls, 'roundRect')).toHaveLength(1);
    expect(named(calls, 'fill')).toHaveLength(1);
  });

  it('draws the picture into a given rect, offset and scaled to it', () => {
    const { context, calls } = recordingContext(1280, 720);
    drawFrame(context, source, SOURCE, still, { x: 100, y: 50, w: 400, h: 225 });
    expect(named(calls, 'drawImage')).toEqual([
      ['drawImage', source, 0, 0, 1280, 720, 100, 50, 400, 225],
    ]);
  });
});

describe('cursor colour, spotlight and motion blur', () => {
  const pointed = {
    ...still,
    camera: { scale: 2, centerX: 0.5, centerY: 0.5 },
    cursor: { x: 0.5, y: 0.5, shape: 'arrow' as const },
  };

  it('fills the cursor in its colour with an outline that stands out from it', () => {
    const light = recordingContext(640, 360);
    drawFrame(light.context, source, SOURCE, { ...pointed, cursorColor: '#ffe14d' });
    expect(light.calls).toContainEqual(['fillStyle=', '#ffe14d']);
    expect(light.calls).toContainEqual(['strokeStyle=', '#111']);
    const dark = recordingContext(640, 360);
    drawFrame(dark.context, source, SOURCE, { ...pointed, cursorColor: '#1a1a40' });
    expect(dark.calls).toContainEqual(['strokeStyle=', '#fff']);
  });

  it('dims the picture away from the cursor only with a spotlight', () => {
    const off = recordingContext(640, 360);
    drawFrame(off.context, source, SOURCE, pointed);
    expect(named(off.calls, 'createRadialGradient')).toHaveLength(0);
    const on = recordingContext(640, 360);
    drawFrame(on.context, source, SOURCE, { ...pointed, spotlight: 0.6 });
    expect(named(on.calls, 'createRadialGradient')).toHaveLength(1);
  });

  it('blurs a moving camera more the faster it moves, and never a still one', () => {
    expect(motionBlurPx(1, 0, 1080)).toBe(0);
    expect(motionBlurPx(0, 3, 1080)).toBe(0);
    expect(motionBlurPx(1, 1, 1080)).toBeGreaterThan(0);
    expect(motionBlurPx(1, 4, 1080)).toBeCloseTo(0.012 * 1080, 0);
    const moving = recordingContext(640, 360);
    drawFrame(moving.context, source, SOURCE, { ...still, cameraMotion: 2 }, undefined, 1);
    expect(
      moving.calls.some((call) => call[0] === 'filter=' && String(call[1]).startsWith('blur(')),
    ).toBe(true);
  });
});

describe('picture quality', () => {
  it('scales the picture with high-quality smoothing, so zoomed text does not shimmer', () => {
    const { context, calls } = recordingContext(640, 360);
    drawFrame(context, source, SOURCE, {
      ...still,
      camera: { scale: 1.6, centerX: 0.4, centerY: 0.5 },
    });
    expect(calls).toContainEqual(['imageSmoothingEnabled=', true]);
    expect(calls).toContainEqual(['imageSmoothingQuality=', 'high']);
  });
});
