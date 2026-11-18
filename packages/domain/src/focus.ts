import {
  asDurationUs,
  asEffectId,
  asTimestampUs,
  type DurationUs,
  type TimestampUs,
} from '@usee/contracts';

import type { CameraRotation, ZoomPose } from './camera';
import type { PointerTrack } from './cursor-path';
import type { ZoomEffect } from './effects';

/**
 * A moment and a place worth looking at, as one focus strategy sees it
 * (docs/module-boundaries.md, "Auto-zoom plug-in seam"). Session time,
 * normalized to the captured display.
 */
export interface FocusCandidate {
  readonly timeUs: number;
  readonly x: number;
  readonly y: number;
  /** How much it matters, 0-1. */
  readonly weight: number;
}

const inFrame = (value: number) => value >= 0 && value <= 1;

/** Click-based focus: every left or right click on the captured display is a candidate. */
export function clickFocusCandidates(track: PointerTrack): FocusCandidate[] {
  return track.clicks
    .filter(
      (click) =>
        (click.button === 'left' || click.button === 'right') &&
        inFrame(click.x) &&
        inFrame(click.y),
    )
    .map((click) => ({ timeUs: click.timeUs, x: click.x, y: click.y, weight: 1 }));
}

/** What makes the pointer's stillness a place worth looking at. */
export interface RestFocusOptions {
  /** It stays at least this long, in microseconds. */
  readonly minRestUs: number;
  /** Within this distance of where it stopped, normalized to the display. */
  readonly radius: number;
  /** After moving at least this far from where the focus last was. */
  readonly minTravel: number;
}

export const DEFAULT_REST_FOCUS: RestFocusOptions = Object.freeze({
  minRestUs: 700_000,
  radius: 0.015,
  minTravel: 0.1,
});

/** A click this long before a rest belongs to it: the click is the focus there already. */
const CLICK_BEFORE_REST_US = 300_000;

/**
 * Rest-based focus (Phase 6): where the pointer, having moved somewhere new,
 * stays still for a while without clicking, as a reader points at what they
 * talk about. Each rest is a candidate at the moment and the place it
 * stopped, weighted below a click. A rest with a click in it is left to the
 * click; one where the pointer has not travelled since the last focus (a
 * click or a rest) is not new. Keystrokes are never read.
 */
export function restFocusCandidates(
  track: PointerTrack,
  sessionEndUs: number,
  options: RestFocusOptions = DEFAULT_REST_FOCUS,
): FocusCandidate[] {
  const { moveTimes: times, moveXs: xs, moveYs: ys } = track;
  const clicks = [...track.clicks].sort((first, second) => first.timeUs - second.timeUs);
  const candidates: FocusCandidate[] = [];
  let lastX = xs[0] ?? 0.5;
  let lastY = ys[0] ?? 0.5;
  let lastTimeUs = -Infinity;
  let index = 0;
  let clickIndex = 0;
  let clickWindowStart = 0;
  let clickWindowEnd = 0;
  while (index < times.length) {
    const at = times[index] ?? 0;
    const x = xs[index] ?? 0;
    const y = ys[index] ?? 0;
    let next = index + 1;
    while (
      next < times.length &&
      Math.hypot((xs[next] ?? 0) - x, (ys[next] ?? 0) - y) <= options.radius
    ) {
      next += 1;
    }
    const until = next < times.length ? (times[next] ?? sessionEndUs) : sessionEndUs;
    // The latest click since the last focus is where the focus last was.
    const lastFocusTimeUs = lastTimeUs;
    let since: (typeof clicks)[number] | undefined;
    while (clickIndex < clicks.length && (clicks[clickIndex]?.timeUs ?? Infinity) < at) {
      const click = clicks[clickIndex];
      if (click !== undefined && click.timeUs > lastFocusTimeUs) {
        since = click;
      }
      clickIndex += 1;
    }
    if (since !== undefined) {
      [lastX, lastY, lastTimeUs] = [since.x, since.y, since.timeUs];
    }
    while (
      clickWindowStart < clicks.length &&
      (clicks[clickWindowStart]?.timeUs ?? Infinity) < at - CLICK_BEFORE_REST_US
    ) {
      clickWindowStart += 1;
    }
    while (
      clickWindowEnd < clicks.length &&
      (clicks[clickWindowEnd]?.timeUs ?? Infinity) <= until
    ) {
      clickWindowEnd += 1;
    }
    const clicked = clickWindowStart < clickWindowEnd;
    if (
      until - at >= options.minRestUs &&
      inFrame(x) &&
      inFrame(y) &&
      !clicked &&
      Math.hypot(x - lastX, y - lastY) >= options.minTravel
    ) {
      candidates.push({ timeUs: at, x, y, weight: 0.6 });
      [lastX, lastY, lastTimeUs] = [x, y, at];
    }
    index = next;
  }
  return candidates;
}

/**
 * One zoom the camera planner proposes: a span of the session the camera
 * closes in on, panning between its poses. Session time.
 */
export interface GeneratedZoom {
  /** Stable for the same input: the time of its first candidate. */
  readonly id: string;
  readonly startUs: TimestampUs;
  readonly durationUs: DurationUs;
  readonly poses: readonly {
    readonly timestampUs: TimestampUs;
    readonly anchor: ZoomPose['anchor'];
  }[];
  readonly easeInUs: number;
  readonly easeOutUs: number;
}

/** What shapes a planned camera; times in microseconds. */
export interface CameraPlanConstraints {
  /** The camera closes in this long before a group's first candidate. */
  readonly leadUs: number;
  /** And stays this long after its last. */
  readonly holdUs: number;
  /** Candidates this close in time share a zoom, so it never zooms out and straight back in. */
  readonly joinGapUs: number;
  readonly rampUs: number;
  /** The camera arrives at a candidate this long before it. */
  readonly panLeadUs: number;
  /** A pan to the next candidate takes at most this long; until it starts, the camera holds. */
  readonly panUs: number;
  /** A candidate this near to where the camera already looks does not move it. */
  readonly settleDistance: number;
}

export const DEFAULT_CAMERA_PLAN: CameraPlanConstraints = Object.freeze({
  leadUs: 1_000_000,
  holdUs: 1_500_000,
  joinGapUs: 4_000_000,
  rampUs: 700_000,
  panLeadUs: 400_000,
  panUs: 600_000,
  settleDistance: 0.08,
});

/**
 * The camera track for a session's candidates: candidates close in time
 * share one zoom, which starts `leadUs` before the first and ends `holdUs`
 * after the last (within the session), and pans to each candidate as it
 * comes, holding on the one before until then. Deterministic: the same
 * candidates always give the same track.
 */
export function planCameraTrack(
  candidates: readonly FocusCandidate[],
  sessionEndUs: number,
  constraints: CameraPlanConstraints = DEFAULT_CAMERA_PLAN,
): GeneratedZoom[] {
  // Whole microseconds throughout, so every planned time is a valid timestamp.
  const sessionEnd = Math.floor(sessionEndUs);
  const sorted = candidates
    .map((candidate) => ({ ...candidate, timeUs: Math.round(candidate.timeUs) }))
    .filter((candidate) => candidate.timeUs >= 0 && candidate.timeUs <= sessionEnd)
    .sort((first, second) => first.timeUs - second.timeUs);
  const groups: FocusCandidate[][] = [];
  for (const candidate of sorted) {
    const group = groups.at(-1);
    const last = group?.at(-1);
    if (
      group !== undefined &&
      last !== undefined &&
      candidate.timeUs - last.timeUs <= constraints.joinGapUs
    ) {
      group.push(candidate);
    } else {
      groups.push([candidate]);
    }
  }

  return groups.flatMap((group) => {
    const first = group[0];
    const last = group.at(-1);
    if (first === undefined || last === undefined) {
      return [];
    }
    const startUs = Math.max(0, first.timeUs - constraints.leadUs);
    const endUs = Math.min(sessionEnd, last.timeUs + constraints.holdUs);
    const durationUs = endUs - startUs;
    if (durationUs <= 0) {
      return [];
    }
    const poses: { timestampUs: TimestampUs; anchor: ZoomPose['anchor'] }[] = [];
    for (const candidate of group) {
      const previous = poses.at(-1);
      const near =
        previous !== undefined &&
        Math.hypot(candidate.x - previous.anchor.x, candidate.y - previous.anchor.y) <
          constraints.settleDistance;
      if (!near) {
        const timestampUs = asTimestampUs(
          Math.min(
            endUs,
            Math.max(
              startUs,
              previous?.timestampUs ?? startUs,
              candidate.timeUs - constraints.panLeadUs,
            ),
          ),
        );
        if (previous !== undefined && timestampUs - previous.timestampUs > constraints.panUs) {
          poses.push({
            timestampUs: asTimestampUs(timestampUs - constraints.panUs),
            anchor: previous.anchor,
          });
        }
        poses.push({ timestampUs, anchor: { x: candidate.x, y: candidate.y } });
      }
    }
    const ramp = Math.min(constraints.rampUs, Math.floor(durationUs / 3));
    return [
      {
        id: `auto-${Math.round(first.timeUs)}`,
        startUs: asTimestampUs(startUs),
        durationUs: asDurationUs(durationUs),
        poses,
        easeInUs: ramp,
        easeOutUs: ramp,
      },
    ];
  });
}

/** How far the generated camera leans at full 3D motion, in degrees. */
const AUTO_TILT = { lean: 6, toward: 12 } as const;
const AUTO_TURN = 15;

/**
 * The generated camera's turn toward an action at `anchor`, at `turn3d`
 * (0-1): an action right of centre brings the picture's right side nearer,
 * one low down its bottom, over a gentle lean back that gives every zoom
 * some depth. Tenths of a degree; none at 0.
 */
export function turnToward(anchor: ZoomPose['anchor'], turn3d: number): CameraRotation | undefined {
  if (!(turn3d > 0)) {
    return undefined;
  }
  const tenth = (degrees: number) => Math.round(degrees * 10) / 10 || 0;
  return {
    x: tenth(turn3d * (AUTO_TILT.lean + AUTO_TILT.toward * (anchor.y - 0.5) * 2)),
    y: tenth(-turn3d * AUTO_TURN * (anchor.x - 0.5) * 2),
    z: 0,
  };
}

/**
 * How much further the generated camera turns when it looks `dx` right and
 * `dy` down of where it planned to, at `turn3d`: the change turnToward would
 * make, unrounded, so a camera that follows the pointer turns smoothly.
 */
export function turnShift(dx: number, dy: number, turn3d: number): CameraRotation {
  return {
    x: turn3d * AUTO_TILT.toward * 2 * dy,
    y: -turn3d * AUTO_TURN * 2 * dx,
    z: 0,
  };
}

/**
 * Generated zooms as zoom effects on media whose time zero is `sessionStartUs`
 * on the session clock, at `scale`, turned toward each action as far as
 * `turn3d` says (none at 0): the camera layer under the clip's own zooms. A
 * zoom wholly before the media starts is left out; one that starts before it
 * is cut to its start.
 */
export function generatedZoomEffects(
  zooms: readonly GeneratedZoom[],
  sessionStartUs: number,
  scale: number,
  turn3d = 0,
): ZoomEffect[] {
  return zooms.flatMap((zoom) => {
    const startUs = zoom.startUs - sessionStartUs;
    const endUs = startUs + zoom.durationUs;
    if (endUs <= 0) {
      return [];
    }
    const from = Math.max(0, startUs);
    const durationUs = endUs - from;
    const ramp = Math.min(zoom.easeInUs, Math.floor(durationUs / 3));
    const effect: ZoomEffect = {
      id: asEffectId(zoom.id),
      kind: 'zoom',
      range: {
        startUs: asTimestampUs(Math.round(from)),
        durationUs: asDurationUs(Math.round(durationUs)),
      },
      enabled: true,
      poses: zoom.poses.map((pose) => {
        const rotation = turnToward(pose.anchor, turn3d);
        return {
          timestampUs: asTimestampUs(
            Math.round(Math.min(endUs, Math.max(from, pose.timestampUs - sessionStartUs))),
          ),
          value: { anchor: pose.anchor, scale, ...(rotation === undefined ? {} : { rotation }) },
          easing: 'ease-in-out',
          // The planner holds on each action until the next pan.
          hold: true,
        };
      }),
      easeInUs: ramp,
      easeOutUs: Math.min(zoom.easeOutUs, Math.floor(durationUs / 3)),
      easing: 'ease-in-out',
    };
    return [effect];
  });
}
