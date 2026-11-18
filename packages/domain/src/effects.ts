import type { EffectId, JsonValue, Point, Rectangle } from '@usee/contracts';

import type { ZoomKeyframe } from './camera';
import type { Easing, Keyframe } from './keyframes';
import type { TimeRange } from './time-range';

export interface RectangleBlurRegion {
  readonly kind: 'rectangle';
  readonly bounds: Rectangle;
}

export interface EllipseBlurRegion {
  readonly kind: 'ellipse';
  readonly bounds: Rectangle;
}

export interface PolygonBlurRegion {
  readonly kind: 'polygon';
  readonly points: readonly Point[];
}

/** Geometry is normalized to the video frame (0-1 across its width and height). */
export type BlurRegion = EllipseBlurRegion | PolygonBlurRegion | RectangleBlurRegion;

/**
 * Every effect belongs to a clip and covers a span of that clip's source
 * media, so it travels with its content through splits, ripple deletes and
 * trims. The part outside the clip's current source range is dormant, not
 * lost: it comes back when the clip is extended again.
 */
export interface EffectBase {
  readonly id: EffectId;
  /** Source time of the clip's asset. */
  readonly range: TimeRange;
  readonly enabled: boolean;
}

/**
 * A zoom (2D camera): ease from the view before it into its poses over
 * `easeInUs`, follow them, and ease back out over `easeOutUs`. One pose
 * holds still; between keyframed poses the camera moves (pans and changes
 * scale), each keyframe's easing shaping the move to the next. A pose is a
 * constrained camera pose, not a second transform system
 * (docs/module-boundaries.md, "3D camera seam").
 */
export interface ZoomEffect extends EffectBase {
  readonly kind: 'zoom';
  /** At least one, in time order, inside the zoom's range. */
  readonly poses: readonly ZoomKeyframe[];
  readonly easeInUs: number;
  readonly easeOutUs: number;
  /** The easing of the ramps in and out. */
  readonly easing: Easing;
  /** The lens's vertical field of view, in degrees; 30 when absent. */
  readonly lens?: number;
}

/**
 * A reusable blur mask: keyframed regions in source time. Between two
 * keyframes the regions move linearly; one keyframe is a still mask. A future
 * object tracker writes the same keyframes (docs/module-boundaries.md,
 * "Blur seam").
 */
export interface BlurEffect extends EffectBase {
  readonly kind: 'blur';
  readonly regions: readonly Keyframe<readonly BlurRegion[]>[];
  /** Blur radius as a fraction of the frame height, (0, 0.2]. */
  readonly intensity: number;
}

/** One line of words, centred at `at`, `size` high as a share of the frame's height. */
export interface TextAnnotation {
  readonly kind: 'text';
  readonly text: string;
  readonly at: Point;
  readonly size: number;
  /** `#rrggbb`. */
  readonly color: string;
  /** On a rounded label in a contrasting shade, so it reads over any picture. */
  readonly background: boolean;
}

/** A line from `from` to `to` with its head at `to`, `lineWidth` thick as a share of the frame's height. */
export interface ArrowAnnotation {
  readonly kind: 'arrow';
  readonly from: Point;
  readonly to: Point;
  readonly lineWidth: number;
  readonly color: string;
}

/** A rounded rectangle's outline, `lineWidth` thick as a share of the frame's height. */
export interface BoxAnnotation {
  readonly kind: 'box';
  readonly bounds: Rectangle;
  readonly lineWidth: number;
  readonly color: string;
}

/** Geometry is normalized to the video frame, so an annotation stays on what it marks as the camera moves. */
export type AnnotationShape = ArrowAnnotation | BoxAnnotation | TextAnnotation;

/**
 * Words or a mark drawn over the picture for a span of the clip's source,
 * fading in and out at its edges (ADR-011). It does not move within its span.
 */
export interface AnnotationEffect extends EffectBase {
  readonly kind: 'annotation';
  readonly shape: AnnotationShape;
}

/** Extension point; parameters stay JSON so projects remain serializable. */
export interface CustomEffect extends EffectBase {
  readonly kind: 'custom';
  readonly type: string;
  readonly parameters: Readonly<Record<string, JsonValue>>;
}

export type Effect = AnnotationEffect | BlurEffect | CustomEffect | ZoomEffect;

/**
 * How a click shows where it lands: a ring spreading out (`ripple`), a dot
 * that pops and fades (`pulse`), a ring closing in on the point (`ring`), the
 * cursor itself pressing in and springing back (`bounce`), or not at all.
 */
export type ClickEffect = 'none' | 'ripple' | 'pulse' | 'ring' | 'bounce';

export const CLICK_EFFECTS: readonly ClickEffect[] = Object.freeze([
  'none',
  'ripple',
  'pulse',
  'ring',
  'bounce',
]);

/**
 * How the editor draws a recorded pointer, for the whole project. The cursor
 * is drawn from the raw stream, so these settings change nothing recorded.
 */
export interface CursorSettings {
  readonly visible: boolean;
  /** Size relative to the cursor as recorded, 0.5-3. */
  readonly size: number;
  /** 0 follows the raw path; 1 is the smoothest. */
  readonly smoothing: number;
  /** How each click shows. */
  readonly clickEffect: ClickEffect;
  /** The cursor's fill, a hex colour; white when absent (since manifest v8). */
  readonly color?: string;
  /**
   * How much the picture dims away from the cursor, so it stands out: 0 (or
   * absent) is none, up to 1 the darkest (since manifest v8).
   */
  readonly spotlight?: number;
}

export const DEFAULT_CURSOR_SETTINGS: CursorSettings = Object.freeze({
  visible: true,
  size: 1.5,
  smoothing: 0.5,
  clickEffect: 'ripple',
});
