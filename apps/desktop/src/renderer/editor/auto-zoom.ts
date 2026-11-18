import type { GeneratedZoomDto, ProjectSnapshot } from '@usee/contracts';
import { generatedZoomEffects, pointerTimeOrigin, type ZoomEffect } from '@usee/domain';

import { effectSpan } from './effect-editing';
import { previewTrack, type SnapshotClip } from './timeline-math';

type SnapshotAsset = ProjectSnapshot['assets'][number];

/**
 * The zooms generated for an asset's session, as zoom effects in the asset's
 * own time, at the project's scale and 3D turn, all of them. They are planned
 * on the session clock, so they come as much later as the picture is older
 * than its timestamp, and meet it.
 */
export function generatedZoomsOf(
  asset: SnapshotAsset,
  settings: ProjectSnapshot['autoZoom'],
): readonly { readonly zoom: GeneratedZoomDto; readonly effect: ZoomEffect }[] {
  const pointer = asset.pointer;
  if (pointer === null) {
    return [];
  }
  return pointer.autoZooms.flatMap((zoom) =>
    generatedZoomEffects([zoom], pointerTimeOrigin(pointer), settings.scale, settings.turn3d).map(
      (effect) => ({ zoom, effect }),
    ),
  );
}

/** The generated camera layer the preview draws under an asset's clips: on, and not turned off. */
export function autoZoomLayer(
  asset: SnapshotAsset,
  settings: ProjectSnapshot['autoZoom'],
): readonly ZoomEffect[] {
  if (!settings.enabled) {
    return [];
  }
  return generatedZoomsOf(asset, settings)
    .filter(({ zoom }) => !settings.disabled.includes(zoom.id))
    .map(({ effect }) => effect);
}

/** A generated zoom where it shows on the timeline: over one clip, in timeline time. */
export interface AutoZoomBar {
  readonly clip: SnapshotClip;
  readonly zoom: GeneratedZoomDto;
  /** As a zoom effect in the clip's source time, at the project's scale and 3D turn. */
  readonly effect: ZoomEffect;
  readonly startUs: number;
  readonly endUs: number;
  readonly disabled: boolean;
}

/** Every generated zoom over a clip of the previewed track, turned off or not. */
export function autoZoomBars(project: ProjectSnapshot): readonly AutoZoomBar[] {
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  return (previewTrack(project)?.clips ?? []).flatMap((clip) => {
    const asset = assets.get(clip.assetId);
    if (asset === undefined) {
      return [];
    }
    return generatedZoomsOf(asset, project.autoZoom).flatMap(({ zoom, effect }) => {
      const span = effectSpan(clip, effect);
      return span === undefined
        ? []
        : [{ clip, zoom, effect, ...span, disabled: project.autoZoom.disabled.includes(zoom.id) }];
    });
  });
}
