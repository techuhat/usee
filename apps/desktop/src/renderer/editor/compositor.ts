import {
  outputAspect,
  pictureLayout,
  type BlurRegion,
  type CanvasStyle,
  type ClickEffect,
  type ActiveAnnotation,
  type FrameComposition,
} from '@usee/domain';

import { cursorGlyph, GLYPH_BOX } from './cursor-glyphs';

export interface PixelSize {
  readonly width: number;
  readonly height: number;
}

export type RenderCanvasContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** A rectangle on the canvas, in canvas pixels. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The picture's place on a styled canvas: its rect plus its corner radius, in pixels. */
export interface PictureRect extends Rect {
  readonly radius: number;
}

/** A click ripple's widest radius, in cursor box heights. */
const RIPPLE_RADIUS = 0.9;

/**
 * One click's effect, `progress` (0-1) of the way through, around (`x`, `y`)
 * in canvas pixels. A bounce shows on the cursor itself (bounceScale).
 */
function drawClick(
  context: RenderCanvasContext,
  effect: ClickEffect,
  x: number,
  y: number,
  boxPx: number,
  progress: number,
): void {
  const fade = 1 - progress;
  context.beginPath();
  switch (effect) {
    case 'ripple': {
      // A ring spreading out over a shadow.
      context.arc(x, y, boxPx * RIPPLE_RADIUS * (0.3 + 0.7 * (1 - fade ** 3)), 0, 2 * Math.PI);
      context.fillStyle = `rgba(0, 0, 0, ${0.22 * fade})`;
      context.fill();
      context.lineWidth = Math.max(1, boxPx * 0.06);
      context.strokeStyle = `rgba(255, 255, 255, ${0.85 * fade})`;
      context.stroke();
      return;
    }
    case 'pulse': {
      // A bright dot that pops out from the point and fades.
      context.arc(x, y, boxPx * (0.3 + 0.6 * (1 - fade ** 2)), 0, 2 * Math.PI);
      context.fillStyle = `rgba(255, 200, 40, ${0.75 * fade})`;
      context.fill();
      return;
    }
    case 'ring': {
      // A ring closing in on the point.
      context.arc(x, y, boxPx * (1.2 - 0.9 * (1 - fade ** 2)), 0, 2 * Math.PI);
      context.lineWidth = Math.max(1, boxPx * 0.14);
      context.strokeStyle = `rgba(255, 255, 255, ${0.9 * fade})`;
      context.shadowColor = `rgba(0, 0, 0, ${0.35 * fade})`;
      context.shadowBlur = boxPx * 0.12;
      context.stroke();
      context.shadowColor = 'transparent';
      return;
    }
    case 'bounce':
    case 'none':
      return;
  }
}

/**
 * How far a moving camera blurs the picture, in pixels of a picture whose
 * smaller side is `sidePx`: up to 1.2 % of it, reached at two view changes a
 * second, scaled by the canvas's motion blur; none below a third of a pixel.
 */
export function motionBlurPx(strength: number, cameraMotion: number, sidePx: number): number {
  const px = strength * Math.min(1, cameraMotion / 2) * 0.012 * sidePx;
  return px < 0.33 ? 0 : Math.round(px * 10) / 10;
}

/** Whether a hex colour is light, so the cursor's outline is dark against it. */
function isLight(color: string): boolean {
  const value = Number.parseInt(color.slice(1, 7), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 140;
}

/** The cursor's size in a bounce: pressed in, then springing back a little past its size, settling. */
function bounceScale(progress: number): number {
  if (progress < 0.2) {
    return 1 - 0.22 * Math.sin((progress / 0.2) * (Math.PI / 2));
  }
  const settle = (progress - 0.2) / 0.8;
  return 1 - 0.22 * Math.exp(-5 * settle) * Math.cos(2.5 * Math.PI * settle);
}

/** Sizes the canvas's pixels to the source's shape within its box on screen, at the screen's density. */
export function fitCanvas(canvas: HTMLCanvasElement, source: PixelSize): void {
  const ratio = window.devicePixelRatio || 1;
  const scale = Math.min(
    (canvas.clientWidth * ratio) / source.width,
    (canvas.clientHeight * ratio) / source.height,
  );
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function traceRegion(context: RenderCanvasContext, region: BlurRegion): void {
  switch (region.kind) {
    case 'rectangle': {
      const { x, y, width, height } = region.bounds;
      context.rect(x, y, width, height);
      return;
    }
    case 'ellipse': {
      const { x, y, width, height } = region.bounds;
      context.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, 2 * Math.PI);
      return;
    }
    case 'polygon':
      region.points.forEach((point, index) => {
        if (index === 0) {
          context.moveTo(point.x, point.y);
        } else {
          context.lineTo(point.x, point.y);
        }
      });
      context.closePath();
      return;
  }
}

function regionBounds(region: BlurRegion) {
  if (region.kind !== 'polygon') {
    const { x, y, width, height } = region.bounds;
    return { left: x, top: y, right: x + width, bottom: y + height };
  }
  const xs = region.points.map((point) => point.x);
  const ys = region.points.map((point) => point.y);
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
  };
}

/** The app's display type, for annotations: drawn on the canvas, never as HTML. */
const ANNOTATION_FONT = '"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif';

/**
 * Draws one annotation (ADR-011) at its opacity, `toX` and `toY` taking the
 * frame's normalized coordinates to the canvas's pixels and `frameHeightPx`
 * the frame's height there, so it zooms and moves with the picture.
 */
function drawAnnotation(
  context: RenderCanvasContext,
  { shape, opacity }: ActiveAnnotation,
  toX: (x: number) => number,
  toY: (y: number) => number,
  frameHeightPx: number,
): void {
  if (!(opacity > 0)) {
    return;
  }
  context.save();
  context.globalAlpha = opacity;
  context.fillStyle = shape.color;
  context.strokeStyle = shape.color;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  // A soft shadow lifts it off busy pictures, light or dark.
  context.shadowColor = 'rgba(0, 0, 0, 0.35)';
  switch (shape.kind) {
    case 'text': {
      const height = shape.size * frameHeightPx;
      const x = toX(shape.at.x);
      const y = toY(shape.at.y);
      context.font = `600 ${height}px ${ANNOTATION_FONT}`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.shadowBlur = height * 0.15;
      context.shadowOffsetY = height * 0.04;
      if (shape.background) {
        const width = context.measureText(shape.text).width;
        const padX = height * 0.4;
        const padY = height * 0.22;
        context.fillStyle = isLight(shape.color)
          ? 'rgba(17, 20, 32, 0.82)'
          : 'rgba(255, 255, 255, 0.88)';
        context.beginPath();
        context.roundRect(
          x - width / 2 - padX,
          y - height / 2 - padY,
          width + 2 * padX,
          height + 2 * padY,
          height * 0.3,
        );
        context.fill();
        context.shadowColor = 'transparent';
        context.fillStyle = shape.color;
      }
      context.fillText(shape.text, x, y);
      break;
    }
    case 'arrow': {
      const width = shape.lineWidth * frameHeightPx;
      const fromX = toX(shape.from.x);
      const fromY = toY(shape.from.y);
      const tipX = toX(shape.to.x);
      const tipY = toY(shape.to.y);
      const angle = Math.atan2(tipY - fromY, tipX - fromX);
      const length = Math.hypot(tipX - fromX, tipY - fromY);
      const head = Math.min(width * 4, length * 0.6);
      // The shaft stops inside the head, so its round end never pokes past the point.
      const shaft = Math.max(0, length - head * 0.8);
      context.shadowBlur = width;
      context.lineWidth = width;
      context.beginPath();
      context.moveTo(fromX, fromY);
      context.lineTo(fromX + Math.cos(angle) * shaft, fromY + Math.sin(angle) * shaft);
      context.stroke();
      const spread = 0.45;
      context.beginPath();
      context.moveTo(tipX, tipY);
      context.lineTo(
        tipX - head * Math.cos(angle - spread),
        tipY - head * Math.sin(angle - spread),
      );
      context.lineTo(
        tipX - head * Math.cos(angle + spread),
        tipY - head * Math.sin(angle + spread),
      );
      context.closePath();
      context.fill();
      break;
    }
    case 'box': {
      const width = shape.lineWidth * frameHeightPx;
      const left = toX(shape.bounds.x);
      const top = toY(shape.bounds.y);
      context.shadowBlur = width;
      context.lineWidth = width;
      context.beginPath();
      context.roundRect(
        left,
        top,
        toX(shape.bounds.x + shape.bounds.width) - left,
        toY(shape.bounds.y + shape.bounds.height) - top,
        width * 1.5,
      );
      context.stroke();
      break;
    }
  }
  context.restore();
}

/**
 * Draws one composed frame into `area` of the canvas (the whole canvas by
 * default): the source through the camera, its blurred regions, the
 * spotlight, annotations, then click effects and the cursor. Positions in `frame` are normalized to the source,
 * so everything zooms with it. A caller that insets or rounds the picture
 * clips `area` before calling this.
 */
export function drawFrame(
  context: RenderCanvasContext,
  source: CanvasImageSource,
  sourceSize: PixelSize,
  frame: FrameComposition,
  area: Rect = { x: 0, y: 0, w: context.canvas.width, h: context.canvas.height },
  motionBlur = 0,
): void {
  const { camera } = frame;
  // Normalized source coordinates to the area's pixels.
  const scaleX = camera.scale * area.w;
  const scaleY = camera.scale * area.h;
  const offsetX = area.x + (0.5 - camera.centerX * camera.scale) * area.w;
  const offsetY = area.y + (0.5 - camera.centerY * camera.scale) * area.h;
  const drawSource = (left: number, top: number, right: number, bottom: number) => {
    context.drawImage(
      source,
      left * sourceSize.width,
      top * sourceSize.height,
      (right - left) * sourceSize.width,
      (bottom - top) * sourceSize.height,
      left * scaleX + offsetX,
      top * scaleY + offsetY,
      (right - left) * scaleX,
      (bottom - top) * scaleY,
    );
  };
  const view = {
    left: camera.centerX - 0.5 / camera.scale,
    top: camera.centerY - 0.5 / camera.scale,
    right: camera.centerX + 0.5 / camera.scale,
    bottom: camera.centerY + 0.5 / camera.scale,
  };

  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  // The picture is scaled every frame, by a factor that sweeps while the camera
  // zooms: high-quality resampling keeps thin strokes such as text from shimmering.
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  // A moving camera blurs the picture as a real lens would, more the faster it moves.
  const blurPx = motionBlurPx(motionBlur, frame.cameraMotion, Math.min(area.w, area.h));
  context.filter = blurPx > 0 ? `blur(${blurPx}px)` : 'none';
  drawSource(view.left, view.top, view.right, view.bottom);
  context.filter = 'none';

  for (const blur of frame.blurs) {
    // The blur radius is a share of the frame's height, so it zooms too.
    const radius = blur.intensity * scaleY;
    // A blurred patch reaches three radii past what it covers, where a Gaussian ends.
    const reachX = (3 * radius) / scaleX;
    const reachY = (3 * radius) / scaleY;
    for (const region of blur.regions) {
      const bounds = regionBounds(region);
      const left = Math.max(0, bounds.left - reachX, view.left - reachX);
      const top = Math.max(0, bounds.top - reachY, view.top - reachY);
      const right = Math.min(1, bounds.right + reachX, view.right + reachX);
      const bottom = Math.min(1, bounds.bottom + reachY, view.bottom + reachY);
      if (right <= left || bottom <= top) {
        continue;
      }
      context.save();
      context.setTransform(scaleX, 0, 0, scaleY, offsetX, offsetY);
      context.beginPath();
      traceRegion(context, region);
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clip();
      // At the frame's edge the blur fades out: black beneath keeps the sharp
      // picture from showing through there.
      context.fillStyle = '#000';
      context.fillRect(area.x, area.y, area.w, area.h);
      context.filter = `blur(${radius}px)`;
      drawSource(left, top, right, bottom);
      context.restore();
    }
  }

  const boxPx = frame.cursorHeight * scaleY;
  if (frame.spotlight > 0 && frame.cursor !== undefined && boxPx > 0) {
    // The picture dims away from the cursor, so the eye follows it.
    const x = frame.cursor.x * scaleX + offsetX;
    const y = frame.cursor.y * scaleY + offsetY;
    const light = context.createRadialGradient(x, y, boxPx * 2, x, y, boxPx * 9);
    light.addColorStop(0, 'rgba(0, 0, 0, 0)');
    light.addColorStop(1, `rgba(0, 0, 0, ${0.65 * frame.spotlight})`);
    context.fillStyle = light;
    context.fillRect(area.x, area.y, area.w, area.h);
  }
  for (const annotation of frame.annotations) {
    drawAnnotation(
      context,
      annotation,
      (x) => x * scaleX + offsetX,
      (y) => y * scaleY + offsetY,
      scaleY,
    );
  }
  for (const click of frame.clicks) {
    const x = click.x * scaleX + offsetX;
    drawClick(context, frame.clickEffect, x, click.y * scaleY + offsetY, boxPx, click.progress);
  }

  if (frame.cursor !== undefined && boxPx > 0) {
    const glyph = cursorGlyph(frame.cursor.shape);
    // A bouncing cursor follows the latest click.
    const pressed =
      frame.clickEffect === 'bounce'
        ? Math.min(...frame.clicks.map((click) => click.progress))
        : Infinity;
    const unit = (boxPx / GLYPH_BOX) * (Number.isFinite(pressed) ? bounceScale(pressed) : 1);
    context.translate(frame.cursor.x * scaleX + offsetX, frame.cursor.y * scaleY + offsetY);
    context.rotate(glyph.rotation ?? 0);
    context.scale(unit, unit);
    context.translate(-glyph.hotspot.x, -glyph.hotspot.y);
    context.shadowColor = 'rgba(0, 0, 0, 0.35)';
    context.shadowBlur = boxPx * 0.12;
    context.shadowOffsetY = boxPx * 0.04;
    context.fillStyle = frame.cursorColor;
    context.fill(glyph.path);
    context.shadowColor = 'transparent';
    context.lineJoin = 'round';
    context.lineWidth = 1.25;
    context.strokeStyle = isLight(frame.cursorColor) ? '#111' : '#fff';
    context.stroke(glyph.path);
  }
  context.restore();
}

/** The output canvas's pixel size for a source: the source's height, the output's shape. */
export function outputCanvasSize(style: CanvasStyle, sourceSize: PixelSize): PixelSize {
  const aspect = outputAspect(style, sourceSize.width / sourceSize.height);
  return { width: Math.max(1, Math.round(sourceSize.height * aspect)), height: sourceSize.height };
}

/** Where the picture sits on a canvas of `W`×`H` pixels, for `style` and a source's shape. */
export function pictureRectOf(
  style: CanvasStyle,
  sourceAspect: number,
  W: number,
  H: number,
): PictureRect {
  const layout = pictureLayout(style, sourceAspect, W / H);
  return {
    x: layout.x * W,
    y: layout.y * H,
    w: layout.width * W,
    h: layout.height * H,
    radius: layout.radius * W,
  };
}

/** Traces the picture's rounded rect as the current path. */
export function tracePicture(context: RenderCanvasContext, rect: PictureRect): void {
  const radius = Math.min(rect.radius, rect.w / 2, rect.h / 2);
  context.beginPath();
  context.roundRect(rect.x, rect.y, rect.w, rect.h, radius);
}

/** Paints a linear gradient covering the canvas, at `angle` degrees (0 points up, clockwise). */
function gradientFill(
  context: RenderCanvasContext,
  W: number,
  H: number,
  from: string,
  to: string,
  angle: number,
): CanvasGradient {
  const radians = (angle * Math.PI) / 180;
  const dx = Math.sin(radians);
  const dy = -Math.cos(radians);
  // A line through the centre long enough to cover the canvas in that direction.
  const half = (Math.abs(dx) * W + Math.abs(dy) * H) / 2;
  const gradient = context.createLinearGradient(
    W / 2 - dx * half,
    H / 2 - dy * half,
    W / 2 + dx * half,
    H / 2 + dy * half,
  );
  gradient.addColorStop(0, from);
  gradient.addColorStop(1, to);
  return gradient;
}

/**
 * Paints the canvas background and returns where the picture goes. The
 * caller then paints the picture's shadow (paintShadow), clips to its shape
 * and draws it there. A blurred recording backdrop is made from
 * `sourceFrame`, the recording's frame being composed, and an image
 * background needs its bitmap; without what it needs the canvas is left with
 * the solid fallback already painted.
 */
export function paintCanvas(
  context: RenderCanvasContext,
  style: CanvasStyle,
  sourceSize: PixelSize,
  sourceFrame?: CanvasImageSource,
  backgroundImage?: CanvasImageSource,
): PictureRect {
  const { width: W, height: H } = context.canvas;
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  const { background } = style;
  if (background.kind === 'solid') {
    context.fillStyle = background.color;
    context.fillRect(0, 0, W, H);
  } else if (background.kind === 'gradient') {
    context.fillStyle = gradientFill(
      context,
      W,
      H,
      background.from,
      background.to,
      background.angle,
    );
    context.fillRect(0, 0, W, H);
  } else if (background.kind === 'blurred-source') {
    // The original recording stays unmodified. Its current frame is only a
    // covered, blurred backdrop behind the separately composed foreground.
    context.fillStyle = '#0b1020';
    context.fillRect(0, 0, W, H);
    if (sourceFrame !== undefined) {
      const blurPx = background.blur * Math.min(W, H);
      context.save();
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.filter = `blur(${blurPx}px)`;
      // Three Gaussian radii reach past each edge. Enlarging first prevents
      // the transparent edge of a Canvas filter from darkening the backdrop.
      coverImage(context, sourceFrame, W, H, 1 + 6 * background.blur);
      context.restore();
    }
  } else {
    // An image background covers the canvas; a neutral fill shows until it loads.
    context.fillStyle = '#0b1020';
    context.fillRect(0, 0, W, H);
    if (backgroundImage !== undefined) {
      context.imageSmoothingQuality = 'high';
      coverImage(context, backgroundImage, W, H);
    }
  }

  context.restore();
  return pictureRectOf(style, sourceSize.width / sourceSize.height, W, H);
}

/**
 * Paints the picture's drop shadow under the shape `trace` makes the current
 * path: its rounded rect, or the outline of a turned card.
 */
export function paintShadow(
  context: RenderCanvasContext,
  style: CanvasStyle,
  trace: () => void,
): void {
  if (style.shadow.opacity <= 0) {
    return;
  }
  const minSide = Math.min(context.canvas.width, context.canvas.height);
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.shadowColor = `rgba(0, 0, 0, ${style.shadow.opacity})`;
  context.shadowBlur = style.shadow.blur * minSide;
  context.shadowOffsetY = style.shadow.offsetY * minSide;
  context.fillStyle = '#000';
  trace();
  context.fill();
  context.restore();
}

/** Covers `W`×`H` with `image`, cropping the overflow (object-fit: cover). */
function coverImage(
  context: RenderCanvasContext,
  image: CanvasImageSource,
  W: number,
  H: number,
  overscale = 1,
): void {
  const size = imageSize(image);
  if (size === undefined) {
    return;
  }
  const scale = Math.max(W / size.width, H / size.height) * overscale;
  const w = size.width * scale;
  const h = size.height * scale;
  context.drawImage(image, (W - w) / 2, (H - h) / 2, w, h);
}

function imageSize(image: CanvasImageSource): PixelSize | undefined {
  if (typeof HTMLImageElement !== 'undefined' && image instanceof HTMLImageElement) {
    return { width: image.naturalWidth, height: image.naturalHeight };
  }
  if (typeof HTMLVideoElement !== 'undefined' && image instanceof HTMLVideoElement) {
    return { width: image.videoWidth, height: image.videoHeight };
  }
  if (typeof VideoFrame !== 'undefined' && image instanceof VideoFrame) {
    return { width: image.displayWidth, height: image.displayHeight };
  }
  if (
    (typeof HTMLCanvasElement !== 'undefined' && image instanceof HTMLCanvasElement) ||
    (typeof OffscreenCanvas !== 'undefined' && image instanceof OffscreenCanvas) ||
    (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap)
  ) {
    return { width: image.width, height: image.height };
  }
  return undefined;
}

/** Clips the context to the picture's rounded rect; the caller draws, then restores. */
export function clipToPicture(context: RenderCanvasContext, rect: PictureRect): void {
  context.setTransform(1, 0, 0, 1, 0, 0);
  tracePicture(context, rect);
  context.clip();
}
