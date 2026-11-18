import { describe, expect, it } from 'vitest';

import {
  asAssetId,
  asClipId,
  asCorrelationId,
  asDurationUs,
  asJobId,
  asProjectId,
  asRecordingSessionId,
  asSchemaVersion,
  asTimestampUs,
  asTimelineId,
  asTrackId,
} from '@usee/contracts';
import {
  DEFAULT_AUTO_ZOOM_SETTINGS,
  DEFAULT_CANVAS_STYLE,
  DEFAULT_CURSOR_SETTINGS,
  EXPORT_PRESETS,
  type ExportJob,
  type Project,
} from '@usee/domain';

import { prepareExportJob } from './export-preparation';
import { compileRenderPlan } from './render-plan';

const correlationId = asCorrelationId('render-test');
const videoId = asAssetId('video-1');
const pointerId = asAssetId('pointer-1');
const sessionId = asRecordingSessionId('session-1');

function project(): Project {
  return {
    id: asProjectId('project-1'),
    schemaVersion: asSchemaVersion(9),
    title: 'Render fixture',
    createdAtUs: asTimestampUs(0),
    updatedAtUs: asTimestampUs(50),
    assets: [
      {
        id: videoId,
        kind: 'video',
        createdAtUs: asTimestampUs(0),
        durationUs: asDurationUs(10_000_000),
        relativePath: 'media/private-recording.mp4',
        dimensions: { width: 1920, height: 1080 },
        frameRate: { numerator: 60, denominator: 1 },
        hasAudio: true,
        sessionStartUs: asTimestampUs(0),
        captureLatencyUs: 31_500,
      },
      {
        id: pointerId,
        kind: 'event',
        createdAtUs: asTimestampUs(0),
        durationUs: asDurationUs(10_000_000),
        relativePath: 'events/pointer.ndjson',
        eventEncoding: 'jsonl',
      },
    ],
    recordingSessions: [
      {
        id: sessionId,
        startedAtUs: asTimestampUs(0),
        endedAtUs: asTimestampUs(10_000_000),
        sources: [],
        videoAssetIds: [videoId],
        audioAssetIds: [],
        interactionAssetId: pointerId,
      },
    ],
    timeline: {
      id: asTimelineId('timeline-1'),
      frameRate: { numerator: 60, denominator: 1 },
      tracks: [
        {
          id: asTrackId('video-track'),
          kind: 'video',
          muted: false,
          clips: [
            {
              id: asClipId('clip-1'),
              assetId: videoId,
              sourceRange: {
                startUs: asTimestampUs(1_000_000),
                durationUs: asDurationUs(8_000_000),
              },
              timelineStartUs: asTimestampUs(2_000_000),
              effects: [],
              speed: 2,
            },
          ],
        },
      ],
    },
    analysisRuns: [],
    settings: {
      defaultFrameRate: { numerator: 60, denominator: 1 },
      previewQuality: 'full',
      colorSpace: 'sdr',
      cursor: DEFAULT_CURSOR_SETTINGS,
      autoZoom: DEFAULT_AUTO_ZOOM_SETTINGS,
      canvas: DEFAULT_CANVAS_STYLE,
    },
  };
}

function exportJob(): ExportJob {
  return {
    id: asJobId('export-1'),
    projectId: asProjectId('project-1'),
    state: 'queued',
    preset: EXPORT_PRESETS['mp4-h264-1080p30'],
    destinationPath: 'C:/exports/output.mp4',
    createdAtUs: asTimestampUs(100),
  };
}

describe('compileRenderPlan', () => {
  it('rejects preset IDs outside the approved registry', () => {
    const result = compileRenderPlan(project(), 'custom-encoder-flags', correlationId);
    expect(result).toMatchObject({ ok: false, error: { code: 'export.preset-unsupported' } });
  });

  it('compiles versioned semantic data without exposing project paths', () => {
    const result = compileRenderPlan(project(), 'mp4-h264-1080p60', correlationId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.planVersion).toBe(1);
    expect(result.value.preset.id).toBe('mp4-h264-1080p60');
    expect(result.value.durationUs).toBe(6_000_000);
    expect(result.value.tracks[0]?.clips[0]).toMatchObject({
      sourceStartUs: 1_000_000,
      sourceDurationUs: 8_000_000,
      timelineStartUs: 2_000_000,
      timelineDurationUs: 4_000_000,
      speed: 2,
      pointer: { streamAssetId: pointerId, sessionId, sessionStartUs: 0, captureLatencyUs: 31_500 },
    });
    expect(result.value.assets.map((asset) => asset.id)).toEqual([videoId, pointerId]);
    expect(JSON.stringify(result.value)).not.toContain('private-recording.mp4');
    expect(JSON.stringify(result.value)).not.toContain('pointer.ndjson');
  });

  it('rejects projects without a visible video clip', () => {
    const model = project();
    const empty: Project = {
      ...model,
      timeline: { ...model.timeline, tracks: [] },
    };
    const result = compileRenderPlan(empty, 'mp4-h264-1080p30', correlationId);
    expect(result).toMatchObject({ ok: false, error: { code: 'export.empty-timeline' } });
  });

  it('rejects a clip whose asset is missing', () => {
    const model = project();
    const track = model.timeline.tracks[0];
    const clip = track?.clips[0];
    if (track === undefined || clip === undefined) throw new Error('fixture is incomplete');
    const invalid: Project = {
      ...model,
      timeline: {
        ...model.timeline,
        tracks: [{ ...track, clips: [{ ...clip, assetId: asAssetId('missing') }] }],
      },
    };
    const result = compileRenderPlan(invalid, 'mp4-h264-1080p30', correlationId);
    expect(result).toMatchObject({ ok: false, error: { code: 'export.asset-missing' } });
  });

  it('rejects clips that run beyond their source asset', () => {
    const model = project();
    const track = model.timeline.tracks[0];
    const clip = track?.clips[0];
    if (track === undefined || clip === undefined) throw new Error('fixture is incomplete');
    const invalid: Project = {
      ...model,
      timeline: {
        ...model.timeline,
        tracks: [
          {
            ...track,
            clips: [
              {
                ...clip,
                sourceRange: {
                  startUs: asTimestampUs(9_000_000),
                  durationUs: asDurationUs(2_000_000),
                },
              },
            ],
          },
        ],
      },
    };
    const result = compileRenderPlan(invalid, 'mp4-h264-1080p30', correlationId);
    expect(result).toMatchObject({ ok: false, error: { code: 'export.asset-range-invalid' } });
  });

  it('refuses an image canvas background until the project format has image assets', () => {
    const model = project();
    const invalid: Project = {
      ...model,
      settings: {
        ...model.settings,
        canvas: { ...model.settings.canvas, background: { kind: 'image', assetId: 'background' } },
      },
    };
    const result = compileRenderPlan(invalid, 'mp4-h264-1080p30', correlationId);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'export.background-image-unsupported' },
    });
  });
});

describe('prepareExportJob', () => {
  it('binds a canonical preset and frozen project revision to the plan hash', () => {
    const model = project();
    const request: ExportJob = {
      ...exportJob(),
      preset: {
        ...EXPORT_PRESETS['mp4-h264-1080p30'],
        dimensions: { width: 320, height: 240 },
      },
    };
    const expectedHash = 'c'.repeat(64);
    const result = prepareExportJob(model, request, correlationId, (plan) => {
      expect(plan.projectUpdatedAtUs).toBe(model.updatedAtUs);
      return expectedHash;
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.job.preset).toEqual(EXPORT_PRESETS['mp4-h264-1080p30']);
    expect(result.value.planHash).toBe(expectedHash);
    expect(Object.isFrozen(result.value.plan)).toBe(true);
    expect(Object.isFrozen(result.value.plan.tracks[0]?.clips[0]?.effects)).toBe(true);
    expect(Object.isFrozen(model)).toBe(false);
    expect(JSON.stringify(result.value.plan)).not.toContain('private-recording.mp4');
  });

  it('rejects a job that names a different project', () => {
    const result = prepareExportJob(
      { ...project(), id: asProjectId('another-project') },
      exportJob(),
      correlationId,
      () => 'c'.repeat(64),
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'export.project-mismatch' } });
  });

  it('rejects a plan hasher result that is not a SHA-256 digest', () => {
    const result = prepareExportJob(project(), exportJob(), correlationId, () => 'unstable-hash');

    expect(result).toMatchObject({ ok: false, error: { code: 'export.plan-hash-invalid' } });
  });
});
