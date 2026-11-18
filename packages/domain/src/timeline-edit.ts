import {
  asDurationUs,
  asTimestampUs,
  err,
  ok,
  type ClipId,
  type EffectId,
  type FrameRate,
  type Result,
  type TimestampUs,
} from '@usee/contracts';

import type { MediaAsset } from './assets';
import { effectProblem } from './effect-rules';
import type { Effect } from './effects';
import type { Clip, Timeline, TimelineTrack } from './timeline';

/**
 * A semantic edit of one clip. Edits ripple: the clips after it on its track
 * move with it, so a track never gains gaps or overlaps. Other tracks are
 * independent.
 */
export type TimelineCommand =
  /** Cuts the clip in two at a timeline time inside it. */
  | { readonly type: 'split'; readonly clipId: ClipId; readonly atUs: TimestampUs }
  /** Removes the clip and closes the gap. */
  | { readonly type: 'delete'; readonly clipId: ClipId }
  /**
   * Moves one edge by `deltaUs` (negative is earlier) as it was dragged. The
   * clip keeps its timeline position: shortening drops media, lengthening
   * reveals more of the source, up to its ends. A relative move, so the first
   * clip's start can still be pulled back to the media it hides.
   */
  | {
      readonly type: 'trim';
      readonly clipId: ClipId;
      readonly edge: 'start' | 'end';
      readonly deltaUs: number;
    }
  /** Adds an effect to a clip; its range must overlap the clip's source range. */
  | { readonly type: 'add-effect'; readonly clipId: ClipId; readonly effect: Effect }
  /** Replaces the clip's effect that has the same ID. */
  | { readonly type: 'update-effect'; readonly clipId: ClipId; readonly effect: Effect }
  | { readonly type: 'remove-effect'; readonly clipId: ClipId; readonly effectId: EffectId }
  /** Plays the clip faster or slower; the clips after it move with its new length. */
  | { readonly type: 'set-clip-speed'; readonly clipId: ClipId; readonly speed: number };

export type TimelineEditError =
  | 'clip-not-found'
  | 'asset-not-found'
  | 'split-outside-clip'
  | 'effect-not-found'
  | 'effect-exists'
  | 'effect-outside-clip'
  | 'effect-invalid'
  | 'speed-invalid';

export interface TimelineEditContext {
  readonly assets: readonly MediaAsset[];
  /** The ID a split gives its second half. */
  readonly newClipId: () => ClipId;
  /** The ID a split gives the second half's copy of an effect that spans the cut. */
  readonly newEffectId: () => EffectId;
}

/** The slowest and fastest a clip may play. */
export const MIN_CLIP_SPEED = 0.25;
export const MAX_CLIP_SPEED = 4;

/** How fast a clip plays its source; 1 when it has no speed of its own. */
export function clipSpeed(clip: Clip): number {
  return clip.speed ?? 1;
}

/** How long a clip lasts on the timeline: its source span at its speed. */
export function clipTimelineDurationUs(clip: Clip): number {
  return Math.round(clip.sourceRange.durationUs / clipSpeed(clip));
}

export function clipEndUs(clip: Clip): number {
  return clip.timelineStartUs + clipTimelineDurationUs(clip);
}

/** Where the last clip on any track ends. */
export function timelineDurationUs(timeline: Timeline): number {
  return Math.max(0, ...timeline.tracks.flatMap((track) => track.clips.map(clipEndUs)));
}

/** The shortest clip an edit may leave: one frame. */
export function minimumClipDurationUs(frameRate: FrameRate): number {
  return Math.ceil((1_000_000 * frameRate.denominator) / frameRate.numerator);
}

/**
 * Applies one command. A command that changes nothing returns the same
 * timeline object, so callers can tell and keep it out of the undo history.
 */
export function applyTimelineCommand(
  timeline: Timeline,
  command: TimelineCommand,
  context: TimelineEditContext,
): Result<Timeline, TimelineEditError> {
  const located = locate(timeline, command.clipId);
  if (located === undefined) {
    return err('clip-not-found');
  }
  const { track, index, clip } = located;
  const minimum = minimumClipDurationUs(timeline.frameRate);

  switch (command.type) {
    case 'split': {
      const offset = command.atUs - clip.timelineStartUs;
      if (offset < minimum || clipTimelineDurationUs(clip) - offset < minimum) {
        return err('split-outside-clip');
      }
      // The timeline offset at the clip's speed is how far into its source the cut falls.
      const sourceOffset = Math.round(offset * clipSpeed(clip));
      // Effects go with the media they cover; one spanning the cut is in both halves.
      const cut = clip.sourceRange.startUs + sourceOffset;
      const first: Clip = {
        ...withSource(clip, clip.sourceRange.startUs, sourceOffset),
        effects: clip.effects.filter((effect) => effect.range.startUs < cut),
      };
      // The second half starts exactly where the first now ends: at a speed the
      // rounded halves can differ from the cut by a microsecond, never leaving a gap.
      const secondStartUs = clip.timelineStartUs + clipTimelineDurationUs(first);
      const second: Clip = {
        ...withSource(clip, cut, clip.sourceRange.durationUs - sourceOffset),
        id: context.newClipId(),
        timelineStartUs: asTimestampUs(secondStartUs),
        effects: clip.effects
          .filter((effect) => effectEndUs(effect) > cut)
          .map((effect) =>
            effect.range.startUs < cut ? { ...effect, id: context.newEffectId() } : effect,
          ),
      };
      // Rounding at a speed can move the end by a microsecond; the next clips follow it.
      const shiftUs = secondStartUs + clipTimelineDurationUs(second) - clipEndUs(clip);
      return ok(
        replaceTrack(timeline, track, splice(track.clips, index, [first, second], shiftUs)),
      );
    }
    case 'delete': {
      const removedUs: number = clipTimelineDurationUs(clip);
      return ok(replaceTrack(timeline, track, splice(track.clips, index, [], -removedUs)));
    }
    case 'trim': {
      const asset = context.assets.find((candidate) => candidate.id === clip.assetId);
      if (asset === undefined) {
        return err('asset-not-found');
      }
      // The edge moved by timeline time; at the clip's speed that is more or less source.
      const speed = clipSpeed(clip);
      const deltaUs = Math.round(command.deltaUs * speed);
      const minimumSource = Math.ceil(minimum * speed);
      let start: number = clip.sourceRange.startUs;
      let duration: number = clip.sourceRange.durationUs;
      if (command.edge === 'end') {
        const longest = Math.max(duration, asset.durationUs - start);
        duration = clamp(duration + deltaUs, Math.min(minimumSource, duration), longest);
      } else {
        // Later trims the head; earlier reveals media before it.
        const shift = clamp(deltaUs, -start, Math.max(0, duration - minimumSource));
        start += shift;
        duration -= shift;
      }
      if (start === clip.sourceRange.startUs && duration === clip.sourceRange.durationUs) {
        return ok(timeline);
      }
      const trimmed = withSource(clip, start, duration);
      return ok(
        replaceTrack(
          timeline,
          track,
          splice(
            track.clips,
            index,
            [trimmed],
            clipTimelineDurationUs(trimmed) - clipTimelineDurationUs(clip),
          ),
        ),
      );
    }
    case 'add-effect':
    case 'update-effect': {
      const { effect } = command;
      const existing = clip.effects.findIndex((candidate) => candidate.id === effect.id);
      if (command.type === 'add-effect' && existing !== -1) {
        return err('effect-exists');
      }
      if (command.type === 'update-effect' && existing === -1) {
        return err('effect-not-found');
      }
      if (effectProblem(effect) !== undefined) {
        return err('effect-invalid');
      }
      const sourceEnd = clip.sourceRange.startUs + clip.sourceRange.durationUs;
      if (effect.range.startUs >= sourceEnd || effectEndUs(effect) <= clip.sourceRange.startUs) {
        return err('effect-outside-clip');
      }
      const effects =
        existing === -1
          ? [...clip.effects, effect]
          : clip.effects.map((candidate, at) => (at === existing ? effect : candidate));
      return ok(
        replaceTrack(timeline, track, splice(track.clips, index, [{ ...clip, effects }], 0)),
      );
    }
    case 'remove-effect': {
      if (!clip.effects.some((effect) => effect.id === command.effectId)) {
        return err('effect-not-found');
      }
      const effects = clip.effects.filter((effect) => effect.id !== command.effectId);
      return ok(
        replaceTrack(timeline, track, splice(track.clips, index, [{ ...clip, effects }], 0)),
      );
    }
    case 'set-clip-speed': {
      if (!(command.speed >= MIN_CLIP_SPEED && command.speed <= MAX_CLIP_SPEED)) {
        return err('speed-invalid');
      }
      if (command.speed === clipSpeed(clip)) {
        return ok(timeline);
      }
      const changed: Clip = { ...clip, speed: command.speed };
      const shiftUs = clipTimelineDurationUs(changed) - clipTimelineDurationUs(clip);
      return ok(replaceTrack(timeline, track, splice(track.clips, index, [changed], shiftUs)));
    }
  }
}

function effectEndUs(effect: Effect): number {
  return effect.range.startUs + effect.range.durationUs;
}

function clamp(value: number, lowest: number, highest: number): number {
  return Math.min(highest, Math.max(lowest, value));
}

function locate(timeline: Timeline, clipId: ClipId) {
  for (const track of timeline.tracks) {
    const clips = [...track.clips].sort((a, b) => a.timelineStartUs - b.timelineStartUs);
    const index = clips.findIndex((clip) => clip.id === clipId);
    const clip = clips[index];
    if (clip !== undefined) {
      return { track: { ...track, clips }, index, clip };
    }
  }
  return undefined;
}

function withSource(clip: Clip, startUs: number, durationUs: number): Clip {
  return {
    ...clip,
    sourceRange: { startUs: asTimestampUs(startUs), durationUs: asDurationUs(durationUs) },
  };
}

/** Replaces the clip at `index` with `replacement` and moves every later clip by `shiftUs`. */
function splice(
  clips: readonly Clip[],
  index: number,
  replacement: readonly Clip[],
  shiftUs: number,
): readonly Clip[] {
  const later = clips
    .slice(index + 1)
    .map((clip) => ({ ...clip, timelineStartUs: asTimestampUs(clip.timelineStartUs + shiftUs) }));
  return [...clips.slice(0, index), ...replacement, ...later];
}

function replaceTrack(timeline: Timeline, track: TimelineTrack, clips: readonly Clip[]): Timeline {
  return {
    ...timeline,
    tracks: timeline.tracks.map((candidate) =>
      candidate.id === track.id ? { ...track, clips } : candidate,
    ),
  };
}
