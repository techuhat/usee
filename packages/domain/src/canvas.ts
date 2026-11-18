/**
 * How the recording sits on the output canvas: a background behind it, an
 * even inset around it, rounded corners and a drop shadow. Pure project data;
 * the preview and export both lay the picture out from it (pictureLayout).
 */
export interface CanvasStyle {
  /** The output's shape, width over height: the source's own, or a chosen preset. */
  readonly aspect: AspectRatio;
  readonly background: CanvasBackground;
  /** The inset around the picture, as a fraction of the output's smaller side (0-0.4). */
  readonly padding: number;
  /** The picture's corner radius, as a fraction of its smaller side (0-0.5). */
  readonly cornerRadius: number;
  readonly shadow: CanvasShadow;
  /**
   * How much a moving camera blurs the picture, as zooms and pans do on a
   * real lens: 0 (or absent) is none, up to 1 the most (since manifest v8).
   */
  readonly motionBlur?: number;
}

/** The output's shape: `source` keeps the recording's own, the rest are fixed presets. */
export type AspectRatio = 'source' | '16:9' | '9:16' | '1:1' | '4:5';

export type CanvasBackground =
  | { readonly kind: 'solid'; readonly color: string }
  /** A linear gradient at `angle` degrees (0 points up), from `from` to `to`. */
  | {
      readonly kind: 'gradient';
      readonly from: string;
      readonly to: string;
      readonly angle: number;
    }
  /** The current recording, covered and blurred behind the framed picture. */
  | {
      readonly kind: 'blurred-source';
      /** Blur radius as a fraction of the output's smaller side (0.01-0.15). */
      readonly blur: number;
    }
  /** An image asset covering the canvas (its ID among the project's assets). */
  | { readonly kind: 'image'; readonly assetId: string };

export interface CanvasShadow {
  /** 0 hides the shadow; up to 1 is the strongest. */
  readonly opacity: number;
  /** Blur radius, as a fraction of the output's smaller side (0-0.2). */
  readonly blur: number;
  /** How far the shadow drops, as a fraction of the output's smaller side (-0.1 to 0.1). */
  readonly offsetY: number;
}

export const DEFAULT_CANVAS_STYLE: CanvasStyle = Object.freeze({
  aspect: 'source',
  background: Object.freeze({ kind: 'solid', color: '#0b1020' }),
  padding: 0,
  cornerRadius: 0,
  shadow: Object.freeze({ opacity: 0, blur: 0.04, offsetY: 0.01 }),
});

const inRange = (value: number, low: number, high: number) =>
  Number.isFinite(value) && value >= low && value <= high;
const isColor = (value: string) => /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value);

/** Why a canvas style is not valid on its own, or undefined when it is. */
export function canvasStyleProblem(style: CanvasStyle): string | undefined {
  if (!inRange(style.padding, 0, 0.4)) {
    return 'padding must be 0-0.4';
  }
  if (!inRange(style.cornerRadius, 0, 0.5)) {
    return 'corner radius must be 0-0.5';
  }
  if (style.motionBlur !== undefined && !inRange(style.motionBlur, 0, 1)) {
    return 'motion blur must be 0-1';
  }
  const { shadow, background } = style;
  if (
    !inRange(shadow.opacity, 0, 1) ||
    !inRange(shadow.blur, 0, 0.2) ||
    !inRange(shadow.offsetY, -0.1, 0.1)
  ) {
    return 'shadow is out of range';
  }
  if (background.kind === 'solid' && !isColor(background.color)) {
    return 'the background colour is not a colour';
  }
  if (background.kind === 'gradient') {
    if (!isColor(background.from) || !isColor(background.to)) {
      return 'the gradient colours are not colours';
    }
    if (!inRange(background.angle, 0, 360)) {
      return 'the gradient angle must be 0-360';
    }
  }
  if (background.kind === 'blurred-source' && !inRange(background.blur, 0.01, 0.15)) {
    return 'backdrop blur must be 0.01-0.15';
  }
  return undefined;
}

/** The output's width over height, the source's own when the style keeps it. */
export function outputAspect(style: CanvasStyle, sourceAspect: number): number {
  switch (style.aspect) {
    case 'source':
      return sourceAspect;
    case '16:9':
      return 16 / 9;
    case '9:16':
      return 9 / 16;
    case '1:1':
      return 1;
    case '4:5':
      return 4 / 5;
  }
}

/**
 * Where the picture sits on the output. `x`/`width` are fractions of the
 * output's width, `y`/`height` of its height; `radius` is a fraction of the
 * output's width, so a renderer can place everything on a canvas of any size.
 */
export interface PictureLayout {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly radius: number;
}

/**
 * Where the picture sits inside the output of `outputAspectRatio` (width over
 * height): inset by an even padding on the output's smaller side, then fitted
 * to keep the source's own shape, centred.
 */
export function pictureLayout(
  style: CanvasStyle,
  sourceAspect: number,
  outputAspectRatio: number,
): PictureLayout {
  // Equal pixel padding on every side, in each axis's own fraction.
  const padX = style.padding * Math.min(1, 1 / outputAspectRatio);
  const padY = style.padding * Math.min(outputAspectRatio, 1);
  const boxW = Math.max(0, 1 - 2 * padX);
  const boxH = Math.max(0, 1 - 2 * padY);
  // The picture's shape in output fractions: wider in x on a tall output.
  const pictureAspect = sourceAspect / outputAspectRatio;
  let width = boxW;
  let height = width / pictureAspect;
  if (height > boxH) {
    height = boxH;
    width = height * pictureAspect;
  }
  // The picture's smaller side, as a fraction of the output's width.
  const smallerSide = Math.min(width, height / outputAspectRatio);
  return {
    x: (1 - width) / 2,
    y: (1 - height) / 2,
    width,
    height,
    radius: style.cornerRadius * smallerSide,
  };
}
