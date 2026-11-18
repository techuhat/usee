import { describe, expect, it, vi } from 'vitest';

import {
  asAssetId,
  asClipId,
  asCorrelationId,
  asDurationUs,
  asJobId,
  asProjectId,
  asTimestampUs,
  asTrackId,
  ok,
} from '@usee/contracts';
import {
  DEFAULT_AUTO_ZOOM_SETTINGS,
  DEFAULT_CANVAS_STYLE,
  DEFAULT_CURSOR_SETTINGS,
  EXPORT_PRESETS,
  type ExportJob,
  type RenderPlan,
} from '@usee/domain';

import { RendererExportFrameSource } from './export-frame-source';

const preset = {
  ...EXPORT_PRESETS['mp4-h264-1080p30'],
  frameRate: { numerator: 1, denominator: 1 },
};
const projectId = asProjectId('project-1');
const exportJob: ExportJob = {
  id: asJobId('export-1'),
  projectId,
  state: 'queued',
  preset,
  destinationPath: 'C:/Videos/output.mp4',
  createdAtUs: asTimestampUs(1),
};
const plan: RenderPlan = {
  planVersion: 1,
  projectId,
  projectUpdatedAtUs: asTimestampUs(1),
  durationUs: asDurationUs(2_000_000),
  frameRate: { numerator: 30, denominator: 1 },
  preset,
  assets: [],
  tracks: [
    {
      id: asTrackId('video-track'),
      kind: 'video',
      muted: false,
      clips: [
        {
          id: asClipId('video-clip'),
          assetId: asAssetId('video-asset'),
          sourceStartUs: 0,
          sourceDurationUs: 2_000_000,
          timelineStartUs: 0,
          timelineDurationUs: 2_000_000,
          speed: 1,
          effects: [],
          pointer: null,
        },
      ],
    },
  ],
  analysisRuns: [],
  canvas: DEFAULT_CANVAS_STYLE,
  cursor: DEFAULT_CURSOR_SETTINGS,
  autoZoom: DEFAULT_AUTO_ZOOM_SETTINGS,
};

const cancellation = (isCanceled = () => false) => ({
  get isCancellationRequested() {
    return isCanceled();
  },
  throwIfCancellationRequested() {
    if (isCanceled()) {
      throw new Error('Canceled');
    }
  },
});

describe('renderer export frame source', () => {
  it('asks two frames ahead, and writes each in order whatever order they come back in', async () => {
    const requests: {
      exportJobId: string;
      requestId: string;
      frameIndex: number;
      timelineUs: number;
    }[] = [];
    const source = new RendererExportFrameSource({
      send: (request) => {
        requests.push(request);
      },
      createCorrelationId: () => asCorrelationId('corr'),
    });
    const frames: Uint8Array[] = [];
    const progress: number[] = [];
    const threeSeconds = { ...plan, durationUs: asDurationUs(3_000_000) };
    const streaming = source.stream(exportJob, threeSeconds, cancellation(), (frame, value) => {
      frames.push(frame);
      progress.push(value);
      return Promise.resolve();
    });
    const answer = (index: number, value: number) =>
      source.submit(exportJob.id, requests[index]?.requestId ?? '', new Uint8Array([value])).ok;

    // The first two at once, the third only once the first is in.
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests.map((request) => request.timelineUs)).toEqual([0, 1_000_000]);
    expect(answer(1, 2)).toBe(true);
    await Promise.resolve();
    expect(frames).toHaveLength(0);
    expect(requests).toHaveLength(2);
    expect(answer(0, 1)).toBe(true);
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2]?.timelineUs).toBe(2_000_000);
    expect(answer(2, 3)).toBe(true);

    await expect(streaming).resolves.toEqual(ok(undefined));
    expect([...frames.map((frame) => frame[0])]).toEqual([1, 2, 3]);
    expect(progress).toEqual([1 / 3, 2 / 3, 1]);
    // Each request is answered once: an answer to it again, or to no request, is refused.
    expect(answer(0, 9)).toBe(false);
  });

  it('stops a pending renderer request when cancellation is requested', async () => {
    const requests: string[] = [];
    const source = new RendererExportFrameSource({
      send: (request) => {
        requests.push(request.requestId);
      },
      createCorrelationId: () => asCorrelationId('corr'),
    });
    let canceled = false;
    const streaming = source.stream(
      exportJob,
      plan,
      cancellation(() => canceled),
      () => Promise.resolve(),
    );
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    canceled = true;

    await expect(streaming).resolves.toMatchObject({
      ok: false,
      error: { code: 'export.canceled' },
    });
  });

  it('rejects a frame when the trusted renderer event could not be delivered', async () => {
    const source = new RendererExportFrameSource({
      send: () => false,
      createCorrelationId: () => asCorrelationId('corr'),
    });
    await expect(
      source.stream(exportJob, plan, cancellation(), () => Promise.resolve()),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'export.render-failed' },
    });
  });
});
