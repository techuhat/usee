import {
  asDurationUs,
  type AssetId,
  type ProjectSnapshot,
  type RecordingSessionId,
} from '@usee/contracts';
import {
  clipSpeed,
  clipTimelineDurationUs,
  timelineDurationUs,
  type AudioAsset,
  type VideoAsset,
} from '@usee/domain';

import type { ProjectSessionState } from './project-session';

/**
 * What the renderer sees of the open project: no filesystem paths, and media
 * only as the URLs `mediaUrl` hands out. Assets without one (interaction
 * streams, unplayable files) are left out; their clips stay, unplayable.
 */
export function toProjectSnapshot(
  state: ProjectSessionState,
  mediaUrl: (assetId: string) => string | undefined,
): ProjectSnapshot {
  const { project } = state;
  // Each recording session's media points at the pointer stream recorded with it,
  // and at the zooms generated from that stream.
  const pointerStreams = new Map<string, { streamId: AssetId; session: RecordingSessionId }>();
  for (const session of project.recordingSessions) {
    const stream = session.interactionAssetId;
    if (stream !== undefined && project.assets.some((asset) => asset.id === stream)) {
      for (const assetId of [...session.videoAssetIds, ...session.audioAssetIds]) {
        pointerStreams.set(assetId, { streamId: stream, session: session.id });
      }
    }
  }
  const pointerFor = (asset: AudioAsset | VideoAsset) => {
    const recorded = pointerStreams.get(asset.id);
    // Without its place on the session clock, media cannot line up with the stream.
    if (recorded === undefined || asset.sessionStartUs === undefined) {
      return null;
    }
    const run = project.analysisRuns.find(
      (candidate) => candidate.kind === 'camera-track' && candidate.sessionId === recorded.session,
    );
    return {
      streamId: recorded.streamId,
      sessionStartUs: asset.sessionStartUs,
      // Audio has no picture to wait for.
      captureLatencyUs: asset.kind === 'video' ? (asset.captureLatencyUs ?? 0) : 0,
      autoZooms: run?.zooms ?? [],
    };
  };
  return {
    projectId: project.id,
    title: project.title,
    revision: state.revision,
    canUndo: state.canUndo,
    canRedo: state.canRedo,
    saveState: state.saveState,
    saveError: state.saveError,
    frameRate: project.timeline.frameRate,
    durationUs: asDurationUs(timelineDurationUs(project.timeline)),
    cursor: project.settings.cursor,
    autoZoom: project.settings.autoZoom,
    canvas: project.settings.canvas,
    hasPointer: pointerStreams.size > 0,
    assets: project.assets.flatMap((asset) => {
      const url = asset.kind === 'event' ? undefined : mediaUrl(asset.id);
      if (asset.kind === 'event' || url === undefined) {
        return [];
      }
      return [
        {
          id: asset.id,
          kind: asset.kind,
          durationUs: asset.durationUs,
          hasAudio: asset.kind === 'audio' || asset.hasAudio,
          mediaUrl: url,
          pointer: pointerFor(asset),
        },
      ];
    }),
    tracks: project.timeline.tracks.map((track) => ({
      id: track.id,
      kind: track.kind,
      muted: track.muted,
      clips: track.clips.map((clip) => ({
        id: clip.id,
        assetId: clip.assetId,
        sourceStartUs: clip.sourceRange.startUs,
        // The clip's length on the timeline: its source span at its speed.
        durationUs: asDurationUs(clipTimelineDurationUs(clip)),
        timelineStartUs: clip.timelineStartUs,
        speed: clipSpeed(clip),
        effects: clip.effects,
      })),
    })),
  };
}
