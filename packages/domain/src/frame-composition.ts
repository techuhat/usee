import { activeAnnotationsAt, type ActiveAnnotation } from './annotations';
import { activeBlursAt, type ActiveBlur } from './blur-mask';
import { followPointer } from './camera-follow';
import { cameraViewAt, type CameraView } from './camera-view';
import { activeClicksAt, cursorAt, type ActiveClick, type CursorPath } from './cursor-path';
import type { ClickEffect, CursorSettings, Effect } from './effects';
import type { CursorShape } from './interaction';

/**
 * The cursor's box at size 1 on a display at 100 % scale, in pixels: about
 * the size of the standard arrow, which fills most of it.
 */
export const CURSOR_BOX_PX = 24;

/**
 * The session time the picture at media time zero shows: the media's place
 * on the session clock, less how much older than its timestamp each picture
 * is. The pointer, the clicks and the camera made from them are read on the
 * session clock from here, so they meet the picture they are drawn over.
 */
export function pointerTimeOrigin(media: {
  readonly sessionStartUs: number;
  readonly captureLatencyUs?: number;
}): number {
  return media.sessionStartUs - (media.captureLatencyUs ?? 0);
}

/** A clip's recorded pointer: its derived path and where the clip's media sits on its clock. */
export interface CursorSource {
  readonly path: CursorPath;
  /** The session time the picture at the media's time zero shows (pointerTimeOrigin). */
  readonly sessionStartUs: number;
  readonly settings: CursorSettings;
}

export interface FrameCursor {
  /** Normalized to the source frame, like every position here. */
  readonly x: number;
  readonly y: number;
  readonly shape: CursorShape;
}

/**
 * Everything a frame shows besides the media, at one moment of a clip's
 * source: the camera, the blurred regions, the cursor and its click effects.
 * Blur, cursor and clicks are in the source frame, under the camera, so
 * they zoom with the picture. Preview and export both draw from this.
 */
export interface FrameComposition {
  readonly camera: CameraView;
  readonly blurs: readonly ActiveBlur[];
  /** The annotations showing, in the clip's order, each with how far it has faded in. */
  readonly annotations: readonly ActiveAnnotation[];
  /** Undefined when there is no recorded pointer, or it is hidden. */
  readonly cursor: FrameCursor | undefined;
  /** The clicks whose effect shows, drawn as `clickEffect` says. */
  readonly clicks: readonly ActiveClick[];
  readonly clickEffect: ClickEffect;
  /** The cursor box's height as a fraction of the frame height; click effects scale with it. */
  readonly cursorHeight: number;
  /** The cursor's fill colour. */
  readonly cursorColor: string;
  /** How much the picture dims away from the cursor, 0-1. */
  readonly spotlight: number;
  /**
   * How fast the camera moves at this moment, in view changes a second (log
   * scale plus centre travel plus turn, in radians): 0 while it holds, so a
   * renderer can blur moves.
   */
  readonly cameraMotion: number;
}

/** How far the camera turned from one view to another, in radians. */
function turnBetween(a: CameraView, b: CameraView): number {
  const [ra, rb] = [a.rotation, b.rotation];
  const degrees = Math.hypot(
    (ra?.x ?? 0) - (rb?.x ?? 0),
    (ra?.y ?? 0) - (rb?.y ?? 0),
    (ra?.z ?? 0) - (rb?.z ?? 0),
  );
  return (degrees * Math.PI) / 180;
}

/** The step back in time over which the camera's motion is measured: a 60 fps frame. */
const MOTION_DT_US = 16_667;

/**
 * `autoZooms` is the generated camera layer for the clip (generatedZoomEffects
 * in focus.ts), turned in 3D as far as `autoTurn3d`: it follows the recorded
 * pointer (followPointer), and the clip's own zooms override it, easing from
 * its view.
 */
export function composeFrame(
  effects: readonly Effect[],
  sourceUs: number,
  pointer?: CursorSource,
  autoZooms: readonly Effect[] = [],
  autoTurn3d = 0,
): FrameComposition {
  /** The generated camera at `us` of the media, keeping the pointer in view. */
  const generatedAt = (us: number) => {
    const view = cameraViewAt(autoZooms, us);
    return pointer === undefined
      ? view
      : followPointer(view, pointer.path, pointer.sessionStartUs + us, autoTurn3d);
  };
  const camera = cameraViewAt(effects, sourceUs, generatedAt(sourceUs));
  const blurs = activeBlursAt(effects, sourceUs);
  const annotations = activeAnnotationsAt(effects, sourceUs);
  const earlierUs = Math.max(0, sourceUs - MOTION_DT_US);
  const earlier = cameraViewAt(effects, earlierUs, generatedAt(earlierUs));
  const cameraMotion =
    sourceUs === earlierUs
      ? 0
      : (Math.abs(Math.log(camera.scale / earlier.scale)) +
          Math.hypot(camera.centerX - earlier.centerX, camera.centerY - earlier.centerY) +
          turnBetween(camera, earlier)) /
        ((sourceUs - earlierUs) / 1_000_000);
  if (pointer === undefined) {
    return {
      camera,
      blurs,
      annotations,
      cursor: undefined,
      clicks: [],
      clickEffect: 'none',
      cursorHeight: 0,
      cursorColor: '#ffffff',
      spotlight: 0,
      cameraMotion,
    };
  }
  const { path, settings } = pointer;
  const sessionUs = pointer.sessionStartUs + sourceUs;
  const state = settings.visible ? cursorAt(path, sessionUs) : undefined;
  return {
    camera,
    blurs,
    annotations,
    cursor:
      state === undefined || !state.visible
        ? undefined
        : { x: state.x, y: state.y, shape: state.shape },
    clicks: settings.clickEffect === 'none' ? [] : activeClicksAt(path, sessionUs),
    clickEffect: settings.clickEffect,
    cursorHeight: (CURSOR_BOX_PX * path.display.dpiScale * settings.size) / path.display.height,
    cursorColor: settings.color ?? '#ffffff',
    spotlight: settings.spotlight ?? 0,
    cameraMotion,
  };
}
