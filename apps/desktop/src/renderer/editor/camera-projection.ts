import {
  applyHomography,
  cardTransform,
  isFlatView,
  type CanvasStyle,
  type FrameComposition,
  type Homography,
} from '@usee/domain';

import {
  clipToPicture,
  drawFrame,
  paintShadow,
  tracePicture,
  type PictureRect,
  type PixelSize,
  type RenderCanvasContext,
  type Rect,
} from './compositor';

// One triangle covering the output; each point carries where it is on the
// output, normalized, top left (0, 0).
const VERTEX_SHADER = `#version 300 es
out vec2 outputPoint;
void main() {
  vec2 corner = vec2(float((gl_VertexID & 1) << 1), float(gl_VertexID & 2));
  outputPoint = vec2(corner.x, 1.0 - corner.y);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

// Each output pixel shows the point of the flat card the camera sees there.
const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D frame;
uniform mat3 toSource;
in vec2 outputPoint;
out vec4 color;
void main() {
  vec3 point = toSource * vec3(outputPoint, 1.0);
  color = texture(frame, point.xy / point.z);
}`;

/** How much sharper than its place a turned card is composed, at most. */
const MAX_DETAIL = 4;
/** The widest flat card composed, in pixels. */
const MAX_CARD_PX = 4096;
/** Points along each rounded corner of a card's outline. */
const CORNER_STEPS = 8;

interface Projection {
  readonly gl: WebGL2RenderingContext;
  readonly toSource: WebGLUniformLocation;
}

type RenderCanvas = HTMLCanvasElement | OffscreenCanvas;
type RenderCanvasFactory = () => RenderCanvas;

/**
 * The two contexts the projector takes from a canvas. On the union above,
 * TypeScript picks a getContext overload by the order it first met the two
 * canvas types, so the linter could read a different type than tsc.
 */
interface ContextCanvas {
  getContext(contextId: '2d'): RenderCanvasContext | null;
  getContext(contextId: 'webgl2', options: WebGLContextAttributes): WebGL2RenderingContext | null;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

function compile(gl: WebGL2RenderingContext, type: GLenum, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) {
    throw new Error('The camera projection could not make a shader.');
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    throw new Error(`A camera projection shader did not compile: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

/** A WebGL 2 context ready to project a card; null where there is no WebGL 2. */
function createProjection(createCanvas: RenderCanvasFactory): Projection | null {
  const canvas: ContextCanvas = createCanvas();
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    preserveDrawingBuffer: true,
  });
  if (gl === null) {
    return null;
  }
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
  gl.linkProgram(program);
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    throw new Error(`The camera projection did not link: ${gl.getProgramInfoLog(program)}`);
  }
  gl.useProgram(program);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  // Mipmaps keep the far side of a turned card from shimmering as it shrinks.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const toSource = gl.getUniformLocation(program, 'toSource');
  if (toSource === null) {
    throw new Error('The camera projection has no transform to set.');
  }
  return { gl, toSource };
}

function resize(canvas: { width: number; height: number }, width: number, height: number): void {
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

/** A point of the picture's place, normalized to it, in canvas pixels. */
const onCanvas = (place: Rect, point: Point): Point => ({
  x: place.x + point.x * place.w,
  y: place.y + point.y * place.h,
});

/**
 * A card's outline on the canvas, its corners rounded as the picture's are:
 * the rounded rect of the picture's place, mapped through `toOutput`, in
 * canvas pixels, clockwise from the top left.
 */
export function cardOutline(toOutput: Homography, place: PictureRect): Point[] {
  const ru = Math.min(0.5, place.radius / place.w);
  const rv = Math.min(0.5, place.radius / place.h);
  const corners: readonly (readonly [number, number, number])[] = [
    [ru, rv, Math.PI],
    [1 - ru, rv, 1.5 * Math.PI],
    [1 - ru, 1 - rv, 0],
    [ru, 1 - rv, 0.5 * Math.PI],
  ];
  const steps = ru > 0 && rv > 0 ? CORNER_STEPS : 0;
  return corners.flatMap(([u, v, from]) =>
    Array.from({ length: steps + 1 }, (_, step) => {
      const angle = from + (step / Math.max(1, steps)) * (Math.PI / 2);
      return onCanvas(
        place,
        applyHomography(toOutput, u + ru * Math.cos(angle), v + rv * Math.sin(angle)),
      );
    }),
  );
}

function traceOutline(context: RenderCanvasContext, outline: readonly Point[]): void {
  context.beginPath();
  outline.forEach((point, index) => {
    if (index === 0) {
      context.moveTo(point.x, point.y);
    } else {
      context.lineTo(point.x, point.y);
    }
  });
  context.closePath();
}

/**
 * How many canvas pixels a pixel of the card at its place's size covers
 * where the card is nearest: so a turned card composed that much larger
 * stays as sharp as a flat one there.
 */
export function cardDetail(toOutput: Homography, place: Rect): number {
  const step = 1e-3;
  let most = 1;
  for (const [u, v] of [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ] as const) {
    const at = applyHomography(toOutput, u, v);
    const across = applyHomography(toOutput, u === 0 ? step : 1 - step, v);
    const down = applyHomography(toOutput, u, v === 0 ? step : 1 - step);
    const reach = (other: Point) =>
      Math.hypot((other.x - at.x) * place.w, (other.y - at.y) * place.h);
    most = Math.max(most, reach(across) / (step * place.w), reach(down) / (step * place.h));
  }
  return Math.min(MAX_DETAIL, most);
}

/** Maps a point normalized to `box` to the same canvas point normalized to `place`. */
function boxToPlace(box: Rect, place: Rect): Homography {
  return [
    box.w / place.w,
    0,
    (box.x - place.x) / place.w,
    0,
    box.h / place.h,
    (box.y - place.y) / place.h,
    0,
    0,
    1,
  ];
}

function multiply(a: Homography, b: Homography): Homography {
  const at = (m: Homography, row: number, column: number) => m[row * 3 + column] ?? 0;
  const cell = (row: number, column: number) =>
    at(a, row, 0) * at(b, 0, column) +
    at(a, row, 1) * at(b, 1, column) +
    at(a, row, 2) * at(b, 2, column);
  return [
    cell(0, 0),
    cell(0, 1),
    cell(0, 2),
    cell(1, 0),
    cell(1, 1),
    cell(1, 2),
    cell(2, 0),
    cell(2, 1),
    cell(2, 2),
  ];
}

/**
 * Draws pictures whose camera turns them in 3D or pulls back from them
 * (docs/rendering-pipeline.md): the camera's flat crop, with its blur, clicks
 * and cursor, fills a card the size of the picture's place; the card is
 * turned and shrunk as cardTransform (packages/domain) says, its rounded
 * corners and shadow with it, over the canvas already painted. A turned card
 * is composed flat at the detail its nearest edge needs, then projected with
 * WebGL 2.
 */
export class CameraProjector {
  readonly #flat: RenderCanvas;
  readonly #createCanvas: RenderCanvasFactory;
  /** Undefined until the first turned card; null where there is no WebGL 2. */
  #projection: Projection | null | undefined;

  constructor(createCanvas: RenderCanvasFactory = () => document.createElement('canvas')) {
    this.#createCanvas = createCanvas;
    this.#flat = createCanvas();
  }

  draw(
    context: RenderCanvasContext,
    source: CanvasImageSource,
    sourceSize: PixelSize,
    frame: FrameComposition,
    place: PictureRect,
    style: CanvasStyle,
    motionBlur = 0,
  ): void {
    const card = cardTransform(frame.camera, sourceSize.width / sourceSize.height);
    const flatFrame = { ...frame, camera: card.crop };
    const turned = !isFlatView(frame.camera);
    const projection = turned ? this.#prepare() : undefined;
    if (projection === null) {
      // Without WebGL 2, a turned picture shows flat in its place.
      paintShadow(context, style, () => tracePicture(context, place));
      context.save();
      clipToPicture(context, place);
      drawFrame(context, source, sourceSize, flatFrame, place, motionBlur);
      context.restore();
      return;
    }
    const outline = cardOutline(card.toOutput, place);
    paintShadow(context, style, () => traceOutline(context, outline));
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    traceOutline(context, outline);
    context.clip();
    if (projection === undefined) {
      // A pull-out: the card is its place, shrunk about its centre.
      const k = frame.camera.scale;
      const shrunk = {
        x: place.x + (place.w * (1 - k)) / 2,
        y: place.y + (place.h * (1 - k)) / 2,
        w: place.w * k,
        h: place.h * k,
      };
      drawFrame(context, source, sourceSize, flatFrame, shrunk, motionBlur);
    } else {
      this.#project(
        context,
        projection,
        source,
        sourceSize,
        flatFrame,
        card,
        outline,
        place,
        motionBlur,
      );
    }
    context.restore();
  }

  /** Lets the GPU context go; a later draw makes a new one. */
  dispose(): void {
    this.#projection?.gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.#projection = undefined;
  }

  #project(
    context: RenderCanvasContext,
    projection: Projection,
    source: CanvasImageSource,
    sourceSize: PixelSize,
    flatFrame: FrameComposition,
    card: ReturnType<typeof cardTransform>,
    outline: readonly Point[],
    place: PictureRect,
    motionBlur: number,
  ): void {
    const { width: W, height: H } = context.canvas;
    const xs = outline.map((point) => point.x);
    const ys = outline.map((point) => point.y);
    const left = Math.max(0, Math.floor(Math.min(...xs)));
    const top = Math.max(0, Math.floor(Math.min(...ys)));
    const right = Math.min(W, Math.ceil(Math.max(...xs)));
    const bottom = Math.min(H, Math.ceil(Math.max(...ys)));
    if (right <= left || bottom <= top) {
      return;
    }
    const box = { x: left, y: top, w: right - left, h: bottom - top };

    const detail = cardDetail(card.toOutput, place);
    const width = Math.max(1, Math.min(MAX_CARD_PX, Math.round(place.w * detail)));
    resize(this.#flat, width, Math.max(1, Math.round((width * place.h) / place.w)));
    const flatCanvas: ContextCanvas = this.#flat;
    const flat = flatCanvas.getContext('2d');
    if (flat === null) {
      return;
    }
    drawFrame(flat, source, sourceSize, flatFrame, undefined, motionBlur);

    const { gl, toSource } = projection;
    resize(gl.canvas, box.w, box.h);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.#flat);
    gl.generateMipmap(gl.TEXTURE_2D);
    const [a, b, c, d, e, f, g, h, i] = multiply(card.toSource, boxToPlace(box, place));
    // GLSL matrices are given column by column.
    gl.uniformMatrix3fv(toSource, false, [a, d, g, b, e, h, c, f, i]);
    gl.viewport(0, 0, box.w, box.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    context.drawImage(gl.canvas, box.x, box.y);
  }

  #prepare(): Projection | null {
    if (this.#projection?.gl.isContextLost() === true) {
      this.#projection = undefined;
    }
    this.#projection ??= createProjection(this.#createCanvas);
    return this.#projection;
  }
}
