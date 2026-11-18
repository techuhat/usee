import type { RenderAssetDto, RenderClipDto, RenderPlanDto } from '@usee/contracts';

export interface VideoFrameDescriptor {
  readonly clip: RenderClipDto;
  readonly asset: Extract<RenderAssetDto, { readonly kind: 'video' }>;
  readonly sourceUs: number;
}

function assetById(plan: RenderPlanDto): Map<string, RenderAssetDto> {
  return new Map(plan.assets.map((asset) => [asset.id, asset]));
}

/** The active video clip and source time for a path-free render-plan moment. */
export function describeVideoFrame(
  plan: RenderPlanDto,
  timelineUs: number,
): VideoFrameDescriptor | undefined {
  const assets = assetById(plan);
  const videoTrack = plan.tracks.find((track) => track.kind === 'video' && !track.muted);
  const clip = videoTrack?.clips.find((candidate) => {
    const asset = assets.get(candidate.assetId);
    return (
      asset?.kind === 'video' &&
      timelineUs >= candidate.timelineStartUs &&
      timelineUs < candidate.timelineStartUs + candidate.timelineDurationUs
    );
  });
  const asset = clip === undefined ? undefined : assets.get(clip.assetId);
  if (clip === undefined || asset?.kind !== 'video') {
    return undefined;
  }
  const sourceUs = Math.min(
    asset.durationUs,
    clip.sourceStartUs + (timelineUs - clip.timelineStartUs) * clip.speed,
  );
  return { clip, asset, sourceUs: Math.max(0, Math.round(sourceUs)) };
}

/** The first picture sets the output's aspect inside its approved size preset. */
export function firstVideoAsset(plan: RenderPlanDto) {
  const assets = assetById(plan);
  const clip = plan.tracks
    .filter((track) => track.kind === 'video' && !track.muted)
    .flatMap((track) => track.clips)
    .find((candidate) => assets.get(candidate.assetId)?.kind === 'video');
  const asset = clip === undefined ? undefined : assets.get(clip.assetId);
  return asset?.kind === 'video' ? asset : undefined;
}
