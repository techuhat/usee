import { describe, expect, it } from 'vitest';

import {
  asAssetId,
  asClipId,
  asDurationUs,
  asProjectId,
  asTimestampUs,
  asTrackId,
  type ProjectSnapshot,
} from '@usee/contracts';

import {
  anchoredScrollLeft,
  clipAt,
  clipAtOrAfter,
  continuesMedia,
  ticksBetween,
  timelineTimeUs,
  nextClip,
  previewTrack,
  type SnapshotClip,
  snapToFrame,
  sourceTimeUs,
} from './timeline-math';

const SECOND = 1_000_000;

function clip(id: string, sourceStart: number, duration: number, start: number): SnapshotClip {
  return {
    id: asClipId(id),
    assetId: asAssetId('recording'),
    sourceStartUs: asTimestampUs(sourceStart * SECOND),
    durationUs: asDurationUs(duration * SECOND),
    timelineStartUs: asTimestampUs(start * SECOND),
    speed: 1,
    effects: [],
  };
}

// A split at 4 s whose second half then lost its first two seconds.
const first = clip('a', 0, 4, 0);
const second = clip('b', 6, 4, 4);

const snapshot: ProjectSnapshot = {
  projectId: asProjectId('p'),
  title: 'Recording',
  revision: 1,
  canUndo: true,
  canRedo: false,
  saveState: 'saved',
  saveError: null,
  frameRate: { numerator: 30, denominator: 1 },
  durationUs: asDurationUs(8 * SECOND),
  cursor: { visible: true, size: 1.5, smoothing: 0.5, clickEffect: 'ripple' },
  autoZoom: { enabled: true, scale: 2, disabled: [] },
  canvas: {
    aspect: 'source',
    background: { kind: 'solid', color: '#0b1020' },
    padding: 0,
    cornerRadius: 0,
    shadow: { opacity: 0, blur: 0.04, offsetY: 0.01 },
  },
  hasPointer: false,
  assets: [],
  tracks: [
    { id: asTrackId('audio'), kind: 'audio', muted: false, clips: [clip('x', 0, 1, 0)] },
    { id: asTrackId('video'), kind: 'video', muted: false, clips: [second, first] },
  ],
};

describe('timeline math', () => {
  it('plays the first video track that has clips', () => {
    expect(previewTrack(snapshot)?.id).toBe('video');
    expect(previewTrack({ ...snapshot, tracks: [] })).toBeUndefined();
  });

  it('finds the clip under a time, start inclusive and end exclusive', () => {
    const track = previewTrack(snapshot);
    expect(clipAt(track, 0)?.id).toBe('a');
    expect(clipAt(track, 4 * SECOND - 1)?.id).toBe('a');
    expect(clipAt(track, 4 * SECOND)?.id).toBe('b');
    expect(clipAt(track, 8 * SECOND)).toBeUndefined();
    if (track !== undefined) {
      expect(nextClip(track, first)?.id).toBe('b');
      expect(nextClip(track, second)).toBeUndefined();
    }
  });

  it('starts playback from a gap at the next clip', () => {
    // A Phase 1 recording's first clip can start a few frames in.
    const late = {
      id: asTrackId('v'),
      kind: 'video',
      muted: false,
      clips: [clip('late', 0, 4, 1)],
    } as const;
    expect(clipAtOrAfter(late, 0)?.id).toBe('late');
    expect(clipAtOrAfter(late, 5 * SECOND)).toBeUndefined();
    expect(clipAtOrAfter(previewTrack(snapshot), 5 * SECOND)?.id).toBe('b');
  });

  it('maps between timeline and source time', () => {
    expect(sourceTimeUs(second, 5 * SECOND)).toBe(7 * SECOND);
    expect(timelineTimeUs(second, 7 * SECOND)).toBe(5 * SECOND);
  });

  it('runs on without a seek only where the media continues', () => {
    expect(continuesMedia(first, clip('c', 4, 2, 4))).toBe(true);
    expect(continuesMedia(first, second)).toBe(false);
    expect(continuesMedia(first, { ...clip('c', 4, 2, 4), assetId: asAssetId('other') })).toBe(
      false,
    );
  });

  it('snaps to the nearest frame start', () => {
    const rate = { numerator: 30, denominator: 1 };
    expect(snapToFrame(0, rate)).toBe(0);
    expect(snapToFrame(16_000, rate)).toBe(0);
    expect(snapToFrame(17_000, rate)).toBe(33_333);
    expect(snapToFrame(SECOND, rate)).toBe(SECOND);
    expect(snapToFrame(1_001_000, { numerator: 30_000, denominator: 1_001 })).toBe(1_001_000);
  });
});

describe('timeline zoom', () => {
  it('keeps the time under the pointer where it is when the scale changes', () => {
    // At 0.1 px/us, 200 px into a viewport scrolled 300 px shows 5 s.
    const scrolled = anchoredScrollLeft(300, 200, 0.0001, 0.0004);
    expect((scrolled + 200) / 0.0004).toBeCloseTo(5_000_000, 3);
    // Zooming out past the start stops at the start.
    expect(anchoredScrollLeft(10, 400, 0.0004, 0.0001)).toBe(0);
  });

  it('lists only the ticks around the visible part of the ruler', () => {
    expect(ticksBetween(4_500_000, 7_200_000, 1_000_000, 60_000_000)).toEqual([
      4_000_000, 5_000_000, 6_000_000, 7_000_000, 8_000_000,
    ]);
    expect(ticksBetween(-1, 2_500_000, 1_000_000, 2_000_000)).toEqual([0, 1_000_000, 2_000_000]);
  });
});

describe('clip speed in timeline math', () => {
  // A clip playing 4 s of source (from 2 s) at 2× over 2 s of timeline, from 1 s.
  const fast: SnapshotClip = { ...clip('f', 2, 2, 1), speed: 2 };

  it('maps timeline time to source time at the clip’s speed, and back', () => {
    expect(sourceTimeUs(fast, 1.5 * SECOND)).toBe(3 * SECOND);
    expect(timelineTimeUs(fast, 3 * SECOND)).toBe(1.5 * SECOND);
    expect(timelineTimeUs(fast, sourceTimeUs(fast, 2.25 * SECOND))).toBe(2.25 * SECOND);
  });

  it('runs on into the next half of a split only at the same speed', () => {
    const next: SnapshotClip = { ...clip('g', 6, 1, 3), speed: 2 };
    expect(continuesMedia(fast, next)).toBe(true);
    expect(continuesMedia(fast, { ...next, speed: 1 })).toBe(false);
  });
});
