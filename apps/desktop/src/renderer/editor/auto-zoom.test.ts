import { describe, expect, it } from 'vitest';

import {
  asAssetId,
  asClipId,
  asDurationUs,
  asProjectId,
  asTimestampUs,
  asTrackId,
  type GeneratedZoomDto,
  type ProjectSnapshot,
} from '@usee/contracts';

import { autoZoomBars, autoZoomLayer } from './auto-zoom';
import type { SnapshotClip } from './timeline-math';

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

function zoom(id: string, start: number, duration: number): GeneratedZoomDto {
  return {
    id,
    startUs: asTimestampUs(start * SECOND),
    durationUs: asDurationUs(duration * SECOND),
    poses: [{ timestampUs: asTimestampUs((start + 0.5) * SECOND), anchor: { x: 0.25, y: 0.5 } }],
    easeInUs: 500_000,
    easeOutUs: 500_000,
  };
}

// The media starts half a second into its session; a cut at 4 s dropped media 4–6 s.
const asset: ProjectSnapshot['assets'][number] = {
  id: asAssetId('recording'),
  kind: 'video',
  durationUs: asDurationUs(10 * SECOND),
  hasAudio: false,
  mediaUrl: `app://media/${'0'.repeat(32)}/recording`,
  pointer: {
    streamId: asAssetId('pointer'),
    sessionStartUs: asTimestampUs(0.5 * SECOND),
    captureLatencyUs: 0,
    autoZooms: [zoom('s-auto-1', 1.5, 2), zoom('s-auto-2', 4, 3.5)],
  },
};

const snapshot: ProjectSnapshot = {
  projectId: asProjectId('p'),
  title: 'Recording',
  revision: 1,
  canUndo: false,
  canRedo: false,
  saveState: 'saved',
  saveError: null,
  frameRate: { numerator: 30, denominator: 1 },
  durationUs: asDurationUs(8 * SECOND),
  cursor: { visible: true, size: 1.5, smoothing: 0.5, clickEffect: 'ripple' },
  autoZoom: { enabled: true, scale: 2, disabled: ['s-auto-1'] },
  canvas: {
    aspect: 'source',
    background: { kind: 'solid', color: '#0b1020' },
    padding: 0,
    cornerRadius: 0,
    shadow: { opacity: 0, blur: 0.04, offsetY: 0.01 },
  },
  hasPointer: true,
  assets: [asset],
  tracks: [
    {
      id: asTrackId('video'),
      kind: 'video',
      muted: false,
      clips: [clip('a', 0, 4, 0), clip('b', 6, 4, 4)],
    },
  ],
};

describe('auto zoom in the editor', () => {
  it('draws the generated zooms that are on, in the media’s own time', () => {
    const layer = autoZoomLayer(asset, snapshot.autoZoom);
    expect(layer.map((effect) => [effect.id, effect.range.startUs])).toEqual([
      ['s-auto-2', 3.5 * SECOND],
    ]);
    expect(layer[0]?.poses[0]?.value).toEqual({ anchor: { x: 0.25, y: 0.5 }, scale: 2 });
    expect(autoZoomLayer(asset, { enabled: true, scale: 3, disabled: [] })).toHaveLength(2);
    expect(autoZoomLayer(asset, { ...snapshot.autoZoom, enabled: false })).toEqual([]);
    expect(autoZoomLayer({ ...asset, pointer: null }, snapshot.autoZoom)).toEqual([]);
  });

  it('moves the generated zooms as much later as the picture is older than its timestamp', () => {
    const late = {
      ...asset,
      pointer: asset.pointer && { ...asset.pointer, captureLatencyUs: 40_000 },
    };
    const layer = autoZoomLayer(late, snapshot.autoZoom);
    expect(layer.map((effect) => [effect.id, effect.range.startUs])).toEqual([
      ['s-auto-2', 3.54 * SECOND],
    ]);
    expect(layer[0]?.poses[0]?.timestampUs).toBe(4.04 * SECOND);
  });

  it('shows each generated zoom over every clip it reaches, turned off or not', () => {
    const bars = autoZoomBars(snapshot).map((bar) => ({
      clip: bar.clip.id,
      zoom: bar.zoom.id,
      startUs: bar.startUs,
      endUs: bar.endUs,
      disabled: bar.disabled,
    }));
    expect(bars).toEqual([
      { clip: 'a', zoom: 's-auto-1', startUs: 1 * SECOND, endUs: 3 * SECOND, disabled: true },
      { clip: 'a', zoom: 's-auto-2', startUs: 3.5 * SECOND, endUs: 4 * SECOND, disabled: false },
      { clip: 'b', zoom: 's-auto-2', startUs: 4 * SECOND, endUs: 5 * SECOND, disabled: false },
    ]);
  });
});
