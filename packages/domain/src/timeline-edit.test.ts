import { describe, expect, it } from 'vitest';

import {
  asAssetId,
  asClipId,
  asEffectId,
  asDurationUs,
  asTimelineId,
  asTimestampUs,
  asTrackId,
  type ClipId,
} from '@usee/contracts';

import type { VideoAsset } from './assets';
import type { ZoomEffect } from './effects';
import type { Clip, Timeline } from './timeline';
import {
  applyTimelineCommand,
  clipEndUs,
  minimumClipDurationUs,
  timelineDurationUs,
  type TimelineCommand,
} from './timeline-edit';

const SECOND = 1_000_000;
const frameRate = { numerator: 60, denominator: 1 };
const FRAME = minimumClipDurationUs(frameRate);

const asset: VideoAsset = {
  id: asAssetId('recording'),
  kind: 'video',
  createdAtUs: asTimestampUs(0),
  durationUs: asDurationUs(10 * SECOND),
  relativePath: 'media/originals/s/recording.mp4',
  dimensions: { width: 1920, height: 1080 },
  frameRate,
  hasAudio: true,
};

function clip(id: string, sourceStart: number, duration: number, timelineStart: number): Clip {
  return {
    id: asClipId(id),
    assetId: asset.id,
    sourceRange: { startUs: asTimestampUs(sourceStart), durationUs: asDurationUs(duration) },
    timelineStartUs: asTimestampUs(timelineStart),
    effects: [],
  };
}

function timelineOf(...clips: Clip[]): Timeline {
  return {
    id: asTimelineId('timeline'),
    frameRate,
    tracks: [
      { id: asTrackId('video'), kind: 'video', muted: false, clips },
      {
        id: asTrackId('audio'),
        kind: 'audio',
        muted: false,
        clips: [clip('other', 0, 10 * SECOND, 0)],
      },
    ],
  };
}

let nextId = 0;
const context = {
  assets: [asset],
  newClipId: () => asClipId(`new-${(nextId += 1)}`),
  newEffectId: () => asEffectId(`effect-${(nextId += 1)}`),
};

function apply(timeline: Timeline, command: TimelineCommand): Timeline {
  const result = applyTimelineCommand(timeline, command, context);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

/** Each video clip as [source start, duration, timeline start], in seconds. */
function shape(timeline: Timeline): number[][] {
  return (timeline.tracks[0]?.clips ?? []).map((c) => [
    c.sourceRange.startUs / SECOND,
    c.sourceRange.durationUs / SECOND,
    c.timelineStartUs / SECOND,
  ]);
}

const at = (seconds: number) => asTimestampUs(Math.round(seconds * SECOND));
const id = (value: string): ClipId => asClipId(value);

describe('split', () => {
  it('cuts a clip into two halves that play the same media back to back', () => {
    const split = apply(timelineOf(clip('a', 0, 10 * SECOND, 0)), {
      type: 'split',
      clipId: id('a'),
      atUs: at(4),
    });
    expect(shape(split)).toEqual([
      [0, 4, 0],
      [4, 6, 4],
    ]);
    expect(split.tracks[0]?.clips[1]?.id).toMatch(/^new-/);
    expect(split.tracks[1]).toEqual(timelineOf().tracks[1]);
  });

  it('refuses a cut within one frame of either end, and unknown clips', () => {
    const timeline = timelineOf(clip('a', 0, 10 * SECOND, 0));
    for (const atUs of [0, FRAME - 1, 10 * SECOND - FRAME + 1, 10 * SECOND, 11 * SECOND]) {
      expect(
        applyTimelineCommand(
          timeline,
          { type: 'split', clipId: id('a'), atUs: at(atUs / SECOND) },
          context,
        ),
      ).toEqual({ ok: false, error: 'split-outside-clip' });
    }
    expect(
      applyTimelineCommand(timeline, { type: 'delete', clipId: id('missing') }, context),
    ).toEqual({ ok: false, error: 'clip-not-found' });
  });
});

describe('ripple delete', () => {
  it('removes the clip and pulls the later ones back', () => {
    const timeline = timelineOf(
      clip('a', 0, 2 * SECOND, 0),
      clip('b', 2 * SECOND, 3 * SECOND, 2 * SECOND),
      clip('c', 5 * SECOND, 5 * SECOND, 5 * SECOND),
    );
    expect(shape(apply(timeline, { type: 'delete', clipId: id('b') }))).toEqual([
      [0, 2, 0],
      [5, 5, 2],
    ]);
  });
});

describe('trim', () => {
  const timeline = timelineOf(
    clip('a', 0, 4 * SECOND, 0),
    clip('b', 6 * SECOND, 2 * SECOND, 4 * SECOND),
  );
  const trim = (clipId: string, edge: 'start' | 'end', seconds: number): TimelineCommand => ({
    type: 'trim',
    clipId: id(clipId),
    edge,
    deltaUs: Math.round(seconds * SECOND),
  });

  it('shortens the end and pulls later clips back', () => {
    expect(shape(apply(timeline, trim('a', 'end', -1)))).toEqual([
      [0, 3, 0],
      [6, 2, 3],
    ]);
  });

  it('extends the end only as far as the media goes', () => {
    expect(shape(apply(timeline, trim('b', 'end', 20)))).toEqual([
      [0, 4, 0],
      [6, 4, 4],
    ]);
  });

  it('moves the start into the media, keeping the clip where it was', () => {
    expect(shape(apply(timeline, trim('b', 'start', 1)))).toEqual([
      [0, 4, 0],
      [7, 1, 4],
    ]);
    // Dragged earlier: hidden media reappears, down to the source's beginning.
    expect(shape(apply(timeline, trim('b', 'start', -10)))).toEqual([
      [0, 4, 0],
      [0, 8, 4],
    ]);
  });

  it('can bring back the head of the first clip', () => {
    const cut = apply(timeline, trim('a', 'start', 2));
    expect(shape(cut)).toEqual([
      [2, 2, 0],
      [6, 2, 2],
    ]);
    expect(shape(apply(cut, trim('a', 'start', -5)))).toEqual(shape(timeline));
  });

  it('never leaves less than one frame', () => {
    const headless = apply(timeline, trim('a', 'start', 9));
    expect(headless.tracks[0]?.clips[0]?.sourceRange.durationUs).toBe(FRAME);
    const tailless = apply(timeline, trim('a', 'end', -4));
    expect(tailless.tracks[0]?.clips[0]?.sourceRange.durationUs).toBe(FRAME);
  });

  it('returns the same timeline when nothing changes', () => {
    expect(apply(timeline, trim('a', 'end', 0))).toBe(timeline);
    expect(apply(timeline, trim('a', 'start', -1))).toBe(timeline);
  });
});

describe('any sequence of edits', () => {
  it('keeps a track contiguous, in order and inside its media', () => {
    // A small deterministic generator, so a failure reproduces exactly.
    let seed = 12_345;
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;

    for (let run = 0; run < 50; run += 1) {
      let timeline = timelineOf(clip('a', 0, 10 * SECOND, 0));
      for (let step = 0; step < 30; step += 1) {
        const clips = timeline.tracks[0]?.clips ?? [];
        const target = clips[Math.floor(random() * clips.length)];
        if (target === undefined) break;
        const position = asTimestampUs(Math.floor(random() * 12 * SECOND));
        const kind = random();
        const speeds = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
        const command: TimelineCommand =
          kind < 0.35
            ? { type: 'split', clipId: target.id, atUs: position }
            : kind < 0.5
              ? { type: 'delete', clipId: target.id }
              : kind < 0.65
                ? {
                    type: 'set-clip-speed',
                    clipId: target.id,
                    speed: speeds[Math.floor(random() * speeds.length)] ?? 1,
                  }
                : {
                    type: 'trim',
                    clipId: target.id,
                    edge: kind < 0.82 ? 'start' : 'end',
                    deltaUs: Math.floor((random() - 0.5) * 8 * SECOND),
                  };
        const result = applyTimelineCommand(timeline, command, context);
        if (result.ok) timeline = result.value;
      }

      const clips = timeline.tracks[0]?.clips ?? [];
      let expectedStart = 0;
      for (const each of clips) {
        expect(each.timelineStartUs).toBe(expectedStart);
        expect(each.sourceRange.durationUs).toBeGreaterThanOrEqual(FRAME);
        expect(each.sourceRange.startUs).toBeGreaterThanOrEqual(0);
        expect(each.sourceRange.startUs + each.sourceRange.durationUs).toBeLessThanOrEqual(
          asset.durationUs,
        );
        expectedStart = clipEndUs(each);
      }
      expect(timelineDurationUs(timeline)).toBe(Math.max(expectedStart, 10 * SECOND));
    }
  });
});

describe('effects through edits', () => {
  const zoom = (id: string, start: number, duration: number): ZoomEffect => ({
    id: asEffectId(id),
    kind: 'zoom',
    range: { startUs: asTimestampUs(start * SECOND), durationUs: asDurationUs(duration * SECOND) },
    enabled: true,
    poses: [
      {
        timestampUs: asTimestampUs(start * SECOND),
        value: { anchor: { x: 0.5, y: 0.5 }, scale: 2 },
        easing: 'ease-in-out',
      },
    ],
    easeInUs: 300_000,
    easeOutUs: 300_000,
    easing: 'ease-in-out',
  });
  const withEffects = (...effects: ZoomEffect[]) =>
    timelineOf({ ...clip('a', 0, 10 * SECOND, 0), effects });
  const effectIds = (timeline: Timeline) =>
    (timeline.tracks[0]?.clips ?? []).map((each) => each.effects.map((effect) => effect.id));

  it('splits effects with the media they cover; one across the cut goes to both halves', () => {
    const split = apply(
      withEffects(zoom('early', 1, 1), zoom('across', 3, 2), zoom('late', 7, 1)),
      {
        type: 'split',
        clipId: id('a'),
        atUs: at(4),
      },
    );
    const [first, second] = effectIds(split);
    expect(first).toEqual(['early', 'across']);
    expect(second?.[0]).toMatch(/^effect-/); // the copy of 'across' gets its own ID
    expect(second?.[1]).toBe('late');
    // The copy covers the same source span, so the zoom continues across the cut.
    expect(split.tracks[0]?.clips[1]?.effects[0]?.range).toEqual(zoom('across', 3, 2).range);
  });

  it('adds, updates and removes an effect, and checks it', () => {
    const timeline = withEffects();
    const added = apply(timeline, { type: 'add-effect', clipId: id('a'), effect: zoom('z', 1, 2) });
    expect(effectIds(added)).toEqual([['z']]);
    const bigger = { ...zoom('z', 1, 2), pose: { anchor: { x: 0.2, y: 0.3 }, scale: 3 } };
    const updated = apply(added, { type: 'update-effect', clipId: id('a'), effect: bigger });
    expect(updated.tracks[0]?.clips[0]?.effects[0]).toEqual(bigger);
    expect(
      effectIds(
        apply(updated, { type: 'remove-effect', clipId: id('a'), effectId: asEffectId('z') }),
      ),
    ).toEqual([[]]);

    const errorOf = (command: TimelineCommand) => {
      const result = applyTimelineCommand(added, command, context);
      return result.ok ? undefined : result.error;
    };
    expect(errorOf({ type: 'add-effect', clipId: id('a'), effect: zoom('z', 1, 2) })).toBe(
      'effect-exists',
    );
    expect(errorOf({ type: 'update-effect', clipId: id('a'), effect: zoom('other', 1, 2) })).toBe(
      'effect-not-found',
    );
    expect(errorOf({ type: 'add-effect', clipId: id('a'), effect: zoom('far', 12, 1) })).toBe(
      'effect-outside-clip',
    );
    expect(
      errorOf({
        type: 'add-effect',
        clipId: id('a'),
        effect: { ...zoom('ramps', 1, 0.5), easeInUs: 400_000, easeOutUs: 400_000 },
      }),
    ).toBe('effect-invalid');
    expect(
      errorOf({ type: 'remove-effect', clipId: id('a'), effectId: asEffectId('missing') }),
    ).toBe('effect-not-found');
  });

  it('keeps effects a trim hides, so extending the clip again brings them back', () => {
    const timeline = withEffects(zoom('late', 8, 1));
    const trimmed = apply(timeline, {
      type: 'trim',
      clipId: id('a'),
      edge: 'end',
      deltaUs: -5 * SECOND,
    });
    expect(effectIds(trimmed)).toEqual([['late']]);
    const restored = apply(trimmed, {
      type: 'trim',
      clipId: id('a'),
      edge: 'end',
      deltaUs: 5 * SECOND,
    });
    expect(restored.tracks[0]?.clips[0]?.sourceRange.durationUs).toBe(10 * SECOND);
    expect(effectIds(restored)).toEqual([['late']]);
  });
});

describe('clip speed', () => {
  const fast = (
    clipId: string,
    sourceStart: number,
    duration: number,
    start: number,
    speed: number,
  ) => ({
    ...clip(clipId, sourceStart, duration, start),
    speed,
  });

  it('takes its source duration divided by its speed on the timeline', () => {
    expect(clipEndUs(fast('a', 0, 4 * SECOND, 0, 2))).toBe(2 * SECOND);
    expect(clipEndUs(fast('a', 0, 4 * SECOND, 0, 0.5))).toBe(8 * SECOND);
    // A clip without a speed plays at its own pace.
    expect(clipEndUs(clip('a', 0, 4 * SECOND, 0))).toBe(4 * SECOND);
  });

  it('ripples the clips after it when its speed changes', () => {
    const before = timelineOf(
      clip('a', 0, 4 * SECOND, 0),
      clip('b', 4 * SECOND, 2 * SECOND, 4 * SECOND),
    );
    const after = apply(before, { type: 'set-clip-speed', clipId: id('a'), speed: 2 });
    const [first, second] = after.tracks[0]?.clips ?? [];
    expect(first?.speed).toBe(2);
    expect(clipEndUs(first as Clip)).toBe(2 * SECOND);
    // The next clip starts where the faster one now ends: no gap, no overlap.
    expect(second?.timelineStartUs).toBe(2 * SECOND);
  });

  it('cuts a fast clip at twice the timeline offset into its source, keeping the speed', () => {
    const before = timelineOf(fast('a', 0, 4 * SECOND, 0, 2));
    const after = apply(before, { type: 'split', clipId: id('a'), atUs: at(0.5) });
    const [first, second] = after.tracks[0]?.clips ?? [];
    expect(first?.sourceRange.durationUs).toBe(1 * SECOND);
    expect(second?.sourceRange.startUs).toBe(1 * SECOND);
    expect(second?.timelineStartUs).toBe(0.5 * SECOND);
    expect(second?.speed).toBe(2);
    expect(clipEndUs(second as Clip)).toBe(2 * SECOND);
  });

  it('trims a fast clip by timeline time, revealing source at its speed', () => {
    const before = timelineOf(fast('a', 0, 4 * SECOND, 0, 2));
    const after = apply(before, { type: 'trim', clipId: id('a'), edge: 'end', deltaUs: SECOND });
    // One more second on the timeline at 2× is two more seconds of source.
    expect(after.tracks[0]?.clips[0]?.sourceRange.durationUs).toBe(6 * SECOND);
    expect(clipEndUs(after.tracks[0]?.clips[0] as Clip)).toBe(3 * SECOND);
  });

  it('refuses a speed out of range and changes nothing at the same speed', () => {
    const before = timelineOf(clip('a', 0, 4 * SECOND, 0));
    expect(
      applyTimelineCommand(before, { type: 'set-clip-speed', clipId: id('a'), speed: 10 }, context),
    ).toEqual({ ok: false, error: 'speed-invalid' });
    expect(
      applyTimelineCommand(before, { type: 'set-clip-speed', clipId: id('a'), speed: 1 }, context),
    ).toEqual({ ok: true, value: before });
  });
});
