import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useStore } from 'zustand';

import type { ProjectSnapshot } from '@usee/contracts';
import {
  composeFrame,
  FULL_FRAME,
  isCropView,
  pointerTimeOrigin,
  type CursorPath,
} from '@usee/domain';

import { autoZoomLayer } from './auto-zoom';
import { CameraProjector } from './camera-projection';
import {
  clipToPicture,
  drawFrame,
  fitCanvas,
  outputCanvasSize,
  paintCanvas,
  paintShadow,
  tracePicture,
} from './compositor';
import { PictureAspect } from './picture-aspect';
import type { PlaybackStore } from './playback-store';
import {
  clipAt,
  clipEndUs,
  continuesMedia,
  frameDurationUs,
  nextClip,
  previewTrack,
  sourceTimeUs,
  timelineTimeUs,
  type SnapshotClip,
  type SnapshotTrack,
} from './timeline-math';

type SnapshotAsset = ProjectSnapshot['assets'][number];

/** How many animation frames a paused seek may take to reach its frame. */
const SETTLE_ATTEMPTS = 12;

/** The frame the video holds now, with its media time; undefined until it has one. */
function grabFrame(video: HTMLVideoElement): VideoFrame | undefined {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    return undefined;
  }
  try {
    return new VideoFrame(video);
  } catch {
    return undefined;
  }
}

/** Where a picture of `source`'s shape sits in the 16:9 player, in percent of it. */
function stageStyle(source: { readonly width: number; readonly height: number }): CSSProperties {
  const share = source.width / source.height / (16 / 9);
  return share >= 1
    ? { left: 0, width: '100%', top: `${(100 - 100 / share) / 2}%`, height: `${100 / share}%` }
    : { top: 0, height: '100%', left: `${(100 - 100 * share) / 2}%`, width: `${100 * share}%` };
}

export interface PlayerProps {
  readonly project: ProjectSnapshot;
  readonly playback: PlaybackStore;
  /** Derived cursor paths by pointer stream ID. */
  readonly cursorPaths: ReadonlyMap<string, CursorPath>;
  /** Shows the whole frame, without the camera, while an effect is edited over it. */
  readonly fullFrame: boolean;
  /** Drawn over the picture, in a box exactly covering it. */
  readonly children?: ReactNode;
}

/**
 * Plays the edited timeline through one <video> element and draws each of
 * its frames onto a canvas with the clip's effects and the recorded cursor
 * (composeFrame in packages/domain, which export uses too). The clip under
 * the playhead picks the media and the source time, and playback jumps the
 * media at each cut; the halves of a split run on without a seek. A
 * recording's own audio plays with its video; a separate audio track is not
 * previewed yet.
 */
export function Player({ project, playback, cursorPaths, fullFrame, children }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const currentClip = useRef<SnapshotClip | undefined>(undefined);
  const [sourceSize, setSourceSize] = useState({ width: 16, height: 9 });
  const [projector] = useState(() => new CameraProjector());
  const playing = useStore(playback, (state) => state.playing);
  const seekVersion = useStore(playback, (state) => state.seekVersion);
  const playheadUs = useStore(playback, (state) => state.playheadUs);

  // Snapshots also arrive when only the save state changed; these keep their
  // identity until their contents change, so nothing is re-seeked or redrawn for nothing.
  const trackJson = JSON.stringify(previewTrack(project) ?? null);
  const track = useMemo(
    () => (JSON.parse(trackJson) as SnapshotTrack | null) ?? undefined,
    [trackJson],
  );
  const assetsJson = JSON.stringify(project.assets);
  const assets = useMemo(
    () => new Map((JSON.parse(assetsJson) as SnapshotAsset[]).map((asset) => [asset.id, asset])),
    [assetsJson],
  );
  // Where each clip plays from: an edit to effects alone needs no seek.
  const layout = JSON.stringify(
    track?.clips.map((clip) => [
      clip.id,
      clip.assetId,
      clip.sourceStartUs,
      clip.durationUs,
      clip.timelineStartUs,
    ]) ?? null,
  );
  const { visible, size, smoothing, clickEffect, color, spotlight } = project.cursor;
  const cursorSettings = useMemo(
    () => ({
      visible,
      size,
      smoothing,
      clickEffect,
      ...(color === undefined ? {} : { color }),
      ...(spotlight === undefined ? {} : { spotlight }),
    }),
    [visible, size, smoothing, clickEffect, color, spotlight],
  );
  // The generated camera layer under each asset's clips, while auto-zoom is on.
  const autoZoomJson = JSON.stringify(project.autoZoom);
  const autoZooms = useMemo(() => {
    const settings = JSON.parse(autoZoomJson) as ProjectSnapshot['autoZoom'];
    return new Map([...assets.values()].map((asset) => [asset.id, autoZoomLayer(asset, settings)]));
  }, [assets, autoZoomJson]);
  const autoTurn3d = project.autoZoom.turn3d ?? 0;
  // The output canvas style; while an effect is edited, the picture shows plain.
  const canvasJson = JSON.stringify(project.canvas);
  const canvasStyle = useMemo(
    () => JSON.parse(canvasJson) as ProjectSnapshot['canvas'],
    [canvasJson],
  );
  const halfFrameUs = frameDurationUs(project.frameRate) / 2;

  /**
   * Draws the video's current frame with its effects: at the frame's own
   * media time while playing; paused, at the playhead, so a paused frame is
   * exactly where the playhead is. The canvas's `data-frame-us` and
   * `data-source-us` say which frame and which moment it shows. Returns
   * whether the frame drawn is the one at the video's position, which a seek
   * may not have reached yet.
   */
  const paint = useEffectEvent((): boolean => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    const context = canvas?.getContext('2d');
    if (canvas === null || video === null || context === null || context === undefined) {
      return true;
    }
    // The clip's latest version: an edit to its effects alone replaces it without a seek.
    const playingClip = currentClip.current;
    const clip =
      playingClip === undefined
        ? undefined
        : (track?.clips.find((candidate) => candidate.id === playingClip.id) ?? playingClip);
    const asset = clip === undefined ? undefined : assets.get(clip.assetId);
    if (clip === undefined || asset === undefined || video.dataset['mediaUrl'] !== asset.mediaUrl) {
      context.fillStyle = '#000';
      context.fillRect(0, 0, canvas.width, canvas.height);
      delete canvas.dataset['sourceUs'];
      delete canvas.dataset['frameUs'];
      return true;
    }
    // One snapshot for every layer, so they all show the same frame.
    const source = grabFrame(video);
    if (source === undefined) {
      return false; // keeps the last frame until this one has loaded
    }
    try {
      const frameUs = source.timestamp;
      const sourceUs = playback.getState().playing
        ? frameUs
        : sourceTimeUs(clip, playback.getState().playheadUs);
      const frameSize = { width: source.displayWidth, height: source.displayHeight };
      const path = asset.pointer === null ? undefined : cursorPaths.get(asset.pointer.streamId);
      const composed = composeFrame(
        clip.effects,
        sourceUs,
        asset.pointer === null || path === undefined
          ? undefined
          : {
              path,
              sessionStartUs: pointerTimeOrigin(asset.pointer),
              settings: cursorSettings,
            },
        autoZooms.get(asset.id),
        autoTurn3d,
      );
      const frame = fullFrame ? { ...composed, camera: FULL_FRAME } : composed;
      // While editing an effect the picture shows plain; otherwise on the styled canvas.
      if (fullFrame) {
        fitCanvas(canvas, frameSize);
        drawFrame(context, source, frameSize, frame);
      } else {
        fitCanvas(canvas, outputCanvasSize(canvasStyle, frameSize));
        const place = paintCanvas(context, canvasStyle, frameSize, source);
        const motionBlur = canvasStyle.motionBlur ?? 0;
        if (isCropView(frame.camera)) {
          paintShadow(context, canvasStyle, () => tracePicture(context, place));
          context.save();
          clipToPicture(context, place);
          drawFrame(context, source, frameSize, frame, place, motionBlur);
          context.restore();
        } else {
          // Turned or pulled back: the picture floats over the canvas as a card.
          projector.draw(context, source, frameSize, frame, place, canvasStyle, motionBlur);
        }
      }
      canvas.dataset['sourceUs'] = String(Math.round(sourceUs));
      canvas.dataset['frameUs'] = String(frameUs);
      const positionUs = video.currentTime * 1_000_000;
      return frameUs <= positionUs + 1_000 && frameUs > positionUs - 2 * halfFrameUs;
    } finally {
      source.close();
    }
  });

  /** Shows the frame at a timeline time: the clip there, its media, its source time. */
  const show = useEffectEvent((timeUs: number) => {
    const video = videoRef.current;
    if (video === null) {
      return;
    }
    const clip = clipAt(track, timeUs);
    currentClip.current = clip;
    const url = clip === undefined ? undefined : assets.get(clip.assetId)?.mediaUrl;
    if (clip === undefined || url === undefined) {
      video.pause();
      paint();
      return;
    }
    if (video.dataset['mediaUrl'] !== url) {
      video.dataset['mediaUrl'] = url;
      video.src = url;
    }
    // The clip plays at its own speed; its sound follows, keeping its pitch.
    video.playbackRate = clip.speed;
    video.currentTime = sourceTimeUs(clip, timeUs) / 1_000_000;
    if (playback.getState().playing) {
      void video.play().catch(() => playback.getState().setPlaying(false));
    }
  });

  /** One step of playback with the video as the clock; false once playback has stopped. */
  const follow = useEffectEvent((): boolean => {
    const video = videoRef.current;
    const clip = currentClip.current;
    if (video === null || track === undefined || clip === undefined) {
      playback.getState().setPlaying(false);
      return false;
    }
    const timeUs = timelineTimeUs(clip, Math.round(video.currentTime * 1_000_000));
    if (!video.ended && timeUs < clipEndUs(clip) - halfFrameUs) {
      playback.getState().advance(Math.max(clip.timelineStartUs, timeUs));
      return true;
    }
    const next = nextClip(track, clip);
    if (next === undefined) {
      playback.getState().advance(clipEndUs(clip));
      playback.getState().setPlaying(false);
      return false;
    }
    playback.getState().advance(next.timelineStartUs);
    if (continuesMedia(clip, next)) {
      currentClip.current = next;
    } else {
      show(next.timelineStartUs);
    }
    return true;
  });

  // A seek, a changed layout or another project: show the frame under the playhead.
  useEffect(() => {
    show(playback.getState().playheadUs);
  }, [seekVersion, layout, assets, playback]);

  useEffect(() => {
    const video = videoRef.current;
    if (video !== null) {
      video.muted = track?.muted ?? false;
    }
  }, [track]);

  // While playing, the video is the clock: follow it, cross cuts, stop at the end.
  useEffect(() => {
    const video = videoRef.current;
    if (!playing || video === null) {
      return;
    }
    let frame = 0;
    const tick = () => {
      if (follow()) {
        frame = requestAnimationFrame(tick);
      }
    };
    void video.play().catch(() => playback.getState().setPlaying(false));
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      video.pause();
    };
  }, [playing, playback]);

  // Paused, the frame is drawn once the video has it: after loading and after
  // each seek. A seek can report itself done while the video still holds the
  // frame from before it, so this tries again on the next animation frames.
  // (Frame callbacks are not dependable for a paused video under the canvas.)
  useEffect(() => {
    const video = videoRef.current;
    if (video === null) {
      return;
    }
    let retry = 0;
    const settle = (attempt: number) => {
      if (!playback.getState().playing && !paint() && attempt < SETTLE_ATTEMPTS) {
        retry = requestAnimationFrame(() => settle(attempt + 1));
      }
    };
    const onFrameReady = () => {
      cancelAnimationFrame(retry);
      settle(0);
    };
    // The picture's shape places the overlay stage.
    const onMetadata = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        setSourceSize({ width: video.videoWidth, height: video.videoHeight });
      }
    };
    video.addEventListener('loadedmetadata', onMetadata);
    video.addEventListener('loadeddata', onFrameReady);
    video.addEventListener('seeked', onFrameReady);
    return () => {
      cancelAnimationFrame(retry);
      video.removeEventListener('loadedmetadata', onMetadata);
      video.removeEventListener('loadeddata', onFrameReady);
      video.removeEventListener('seeked', onFrameReady);
    };
  }, [playback]);

  // Playing, every frame the video presents is drawn at its own time.
  useEffect(() => {
    const video = videoRef.current;
    if (!playing || video === null) {
      return;
    }
    let handle = 0;
    const onFrame: VideoFrameRequestCallback = () => {
      paint();
      handle = video.requestVideoFrameCallback(onFrame);
    };
    handle = video.requestVideoFrameCallback(onFrame);
    return () => video.cancelVideoFrameCallback(handle);
  }, [playing]);

  // New effects, cursor settings or a loaded pointer stream: draw the paused frame again.
  useEffect(() => {
    if (!playback.getState().playing) {
      paint();
    }
  }, [track, assets, cursorPaths, cursorSettings, autoZooms, canvasStyle, fullFrame, playback]);

  useEffect(() => () => projector.dispose(), [projector]);

  // A resized player: draw the paused frame at the new size.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (!playback.getState().playing) {
        paint();
      }
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [playback]);

  const clipUnderPlayhead = clipAt(track, playheadUs);
  const notice =
    clipUnderPlayhead === undefined
      ? 'Nothing at the playhead'
      : assets.has(clipUnderPlayhead.assetId)
        ? undefined
        : 'This clip’s media is missing';

  return (
    <div className={playing ? 'player playing' : 'player'}>
      <video
        ref={videoRef}
        className="player-video"
        data-testid="preview-video"
        preload="auto"
        crossOrigin="anonymous"
      />
      <canvas ref={canvasRef} className="player-canvas" data-testid="preview-canvas" />
      {children !== undefined && (
        <div className="player-stage" style={stageStyle(sourceSize)} data-testid="preview-stage">
          <PictureAspect value={sourceSize.width / sourceSize.height}>{children}</PictureAspect>
        </div>
      )}
      {notice !== undefined && <p className="player-empty">{notice}</p>}
    </div>
  );
}
