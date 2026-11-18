import type { FrameRate, ProjectSnapshot } from '@usee/contracts';

export type SnapshotTrack = ProjectSnapshot['tracks'][number];
export type SnapshotClip = SnapshotTrack['clips'][number];

export function clipEndUs(clip: SnapshotClip): number {
  return clip.timelineStartUs + clip.durationUs;
}

/** The track the preview plays: the first video track with clips, else the first with any. */
export function previewTrack(snapshot: ProjectSnapshot): SnapshotTrack | undefined {
  return (
    snapshot.tracks.find((track) => track.kind === 'video' && track.clips.length > 0) ??
    snapshot.tracks.find((track) => track.clips.length > 0)
  );
}

/** The clip playing at `timeUs`: its start is at or before, its end after. */
export function clipAt(track: SnapshotTrack | undefined, timeUs: number): SnapshotClip | undefined {
  return track?.clips.find((clip) => clip.timelineStartUs <= timeUs && timeUs < clipEndUs(clip));
}

/** The clip at `timeUs`, or else the first one after it: where playback from there begins. */
export function clipAtOrAfter(
  track: SnapshotTrack | undefined,
  timeUs: number,
): SnapshotClip | undefined {
  return (
    clipAt(track, timeUs) ??
    track?.clips
      .filter((clip) => clip.timelineStartUs > timeUs)
      .reduce<SnapshotClip | undefined>(
        (earliest, clip) =>
          earliest === undefined || clip.timelineStartUs < earliest.timelineStartUs
            ? clip
            : earliest,
        undefined,
      )
  );
}

/** The clip after `clip` on its track, in timeline order. */
export function nextClip(track: SnapshotTrack, clip: SnapshotClip): SnapshotClip | undefined {
  return track.clips
    .filter((candidate) => candidate.timelineStartUs >= clipEndUs(clip))
    .reduce<SnapshotClip | undefined>(
      (earliest, candidate) =>
        earliest === undefined || candidate.timelineStartUs < earliest.timelineStartUs
          ? candidate
          : earliest,
      undefined,
    );
}

/** The moment of the clip's source shown at a timeline time: its offset at the clip's speed. */
export function sourceTimeUs(clip: SnapshotClip, timelineUs: number): number {
  return clip.sourceStartUs + (timelineUs - clip.timelineStartUs) * clip.speed;
}

/** Where a moment of the clip's source falls on the timeline. */
export function timelineTimeUs(clip: SnapshotClip, sourceUs: number): number {
  return clip.timelineStartUs + (sourceUs - clip.sourceStartUs) / clip.speed;
}

/**
 * Whether `next` picks up exactly where `clip`'s media leaves off, as the two
 * halves of a split do, so playback can run on without a seek.
 */
export function continuesMedia(clip: SnapshotClip, next: SnapshotClip): boolean {
  return (
    next.assetId === clip.assetId &&
    next.speed === clip.speed &&
    next.timelineStartUs === clipEndUs(clip) &&
    Math.abs(next.sourceStartUs - (clip.sourceStartUs + clip.durationUs * clip.speed)) <= 1
  );
}

export function frameDurationUs(frameRate: FrameRate): number {
  return (1_000_000 * frameRate.denominator) / frameRate.numerator;
}

/** The start of the frame nearest `timeUs`, in whole microseconds. */
export function snapToFrame(timeUs: number, frameRate: FrameRate): number {
  const frame = Math.round(timeUs / frameDurationUs(frameRate));
  return Math.floor((frame * 1_000_000 * frameRate.denominator) / frameRate.numerator);
}

export function clamp(value: number, lowest: number, highest: number): number {
  return Math.min(highest, Math.max(lowest, value));
}

/**
 * The scroll position that keeps the time at `anchorPx` (measured from the
 * viewport's left edge) where it is on screen when the scale changes.
 */
export function anchoredScrollLeft(
  scrollLeft: number,
  anchorPx: number,
  fromPxPerUs: number,
  toPxPerUs: number,
): number {
  return Math.max(0, ((scrollLeft + anchorPx) / fromPxPerUs) * toPxPerUs - anchorPx);
}

/** The ruler's ticks, every `stepUs` within [0, spanUs], from the last before `fromUs` to the first after `toUs`. */
export function ticksBetween(
  fromUs: number,
  toUs: number,
  stepUs: number,
  spanUs: number,
): number[] {
  const ticks: number[] = [];
  const first = Math.max(0, Math.floor(fromUs / stepUs));
  const last = Math.min(Math.floor(spanUs / stepUs), Math.ceil(toUs / stepUs));
  for (let index = first; index <= last; index += 1) {
    ticks.push(index * stepUs);
  }
  return ticks;
}
