import { createAppError, err, ok, type CorrelationId, type Result } from '@usee/contracts';
import {
  EXPORT_PRESETS,
  clipSpeed,
  clipTimelineDurationUs,
  timelineDurationUs,
  type ExportPresetId,
  type Project,
  type RenderAsset,
  type RenderPlan,
  type RenderTrack,
} from '@usee/domain';

export type RenderPlanErrorCode =
  | 'export.preset-unsupported'
  | 'export.empty-timeline'
  | 'export.asset-missing'
  | 'export.asset-range-invalid'
  | 'export.background-image-unsupported';

function failure(code: RenderPlanErrorCode, correlationId: CorrelationId) {
  return err(
    createAppError({
      category: 'export',
      code,
      retryable: false,
      userMessageKey: `errors.${code}`,
      correlationId,
    }),
  );
}

function toRenderAsset(asset: Project['assets'][number]): RenderAsset {
  switch (asset.kind) {
    case 'video':
      return {
        id: asset.id,
        kind: asset.kind,
        durationUs: asset.durationUs,
        dimensions: asset.dimensions,
        frameRate: asset.frameRate,
        hasAudio: asset.hasAudio,
      };
    case 'audio':
      return {
        id: asset.id,
        kind: asset.kind,
        durationUs: asset.durationUs,
        channels: asset.channels,
        sampleRateHz: asset.sampleRateHz,
      };
    case 'event':
      return {
        id: asset.id,
        kind: asset.kind,
        durationUs: asset.durationUs,
        eventEncoding: asset.eventEncoding,
      };
  }
}

/**
 * Compiles the immutable project model into the versioned export description.
 * Paths are deliberately omitted; an execution adapter resolves asset IDs
 * against the already-open, validated project.
 */
export function compileRenderPlan(
  project: Project,
  presetId: string,
  correlationId: CorrelationId,
): Result<RenderPlan> {
  if (!Object.keys(EXPORT_PRESETS).includes(presetId)) {
    return failure('export.preset-unsupported', correlationId);
  }
  const preset = EXPORT_PRESETS[presetId as ExportPresetId];

  if (project.settings.canvas.background.kind === 'image') {
    return failure('export.background-image-unsupported', correlationId);
  }

  const assetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const pointerByMediaAsset = new Map<
    string,
    {
      readonly streamAssetId: Project['assets'][number]['id'];
      readonly sessionId: Project['recordingSessions'][number]['id'];
      readonly sessionStartUs: number;
      readonly captureLatencyUs?: number;
    }
  >();
  for (const session of project.recordingSessions) {
    const stream = session.interactionAssetId;
    if (stream === undefined || assetsById.get(stream)?.kind !== 'event') {
      continue;
    }
    for (const assetId of [...session.videoAssetIds, ...session.audioAssetIds]) {
      const asset = assetsById.get(assetId);
      if (asset?.kind !== 'event' && asset?.sessionStartUs !== undefined) {
        pointerByMediaAsset.set(assetId, {
          streamAssetId: stream,
          sessionId: session.id,
          sessionStartUs: asset.sessionStartUs,
          ...(asset.kind === 'video' && asset.captureLatencyUs !== undefined
            ? { captureLatencyUs: asset.captureLatencyUs }
            : {}),
        });
      }
    }
  }

  const usedAssetIds = new Set<string>();
  let hasVideo = false;
  const tracks: RenderTrack[] = [];
  for (const track of project.timeline.tracks) {
    const clips: RenderTrack['clips'][number][] = [];
    for (const clip of track.clips) {
      const asset = assetsById.get(clip.assetId);
      if (asset === undefined || asset.kind === 'event') {
        return failure('export.asset-missing', correlationId);
      }
      if (
        clip.sourceRange.durationUs <= 0 ||
        clip.sourceRange.startUs + clip.sourceRange.durationUs > asset.durationUs
      ) {
        return failure('export.asset-range-invalid', correlationId);
      }
      hasVideo ||= asset.kind === 'video' && track.kind === 'video' && !track.muted;
      usedAssetIds.add(asset.id);
      const pointer = pointerByMediaAsset.get(asset.id) ?? null;
      if (pointer !== null) {
        usedAssetIds.add(pointer.streamAssetId);
      }
      clips.push({
        id: clip.id,
        assetId: clip.assetId,
        sourceStartUs: clip.sourceRange.startUs,
        sourceDurationUs: clip.sourceRange.durationUs,
        timelineStartUs: clip.timelineStartUs,
        timelineDurationUs: clipTimelineDurationUs(clip),
        speed: clipSpeed(clip),
        effects: clip.effects,
        pointer,
      });
    }
    tracks.push({ id: track.id, kind: track.kind, muted: track.muted, clips });
  }

  const durationUs = timelineDurationUs(project.timeline);
  if (!hasVideo || durationUs <= 0) {
    return failure('export.empty-timeline', correlationId);
  }

  const assets = project.assets.filter((asset) => usedAssetIds.has(asset.id)).map(toRenderAsset);
  const usedSessions = new Set(
    tracks.flatMap((track) =>
      track.clips.flatMap((clip) => (clip.pointer === null ? [] : [clip.pointer.sessionId])),
    ),
  );

  return ok({
    planVersion: 1,
    projectId: project.id,
    projectUpdatedAtUs: project.updatedAtUs,
    durationUs,
    frameRate: project.timeline.frameRate,
    preset,
    assets,
    tracks,
    analysisRuns: project.analysisRuns.filter(
      (run) => run.kind !== 'camera-track' || usedSessions.has(run.sessionId),
    ),
    canvas: project.settings.canvas,
    cursor: project.settings.cursor,
    autoZoom: project.settings.autoZoom,
  });
}
