import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useStore } from 'zustand';

import type { EffectDto, ProjectSnapshot } from '@usee/contracts';

import { autoZoomBars } from './auto-zoom';
import { zoomIs3d } from './camera-moves';
import { filmstripTiles, type FilmstripFrame } from './filmstrip';
import { effectKeyframes, effectSpan } from './effect-editing';
import type { PlaybackStore } from './playback-store';
import type { DecodedWaveform } from './project-store';
import { formatTimecode } from './timecode';
import {
  anchoredScrollLeft,
  clamp,
  clipEndUs,
  previewTrack,
  ticksBetween,
  timelineTimeUs,
  type SnapshotClip,
} from './timeline-math';
import { drawWaveform } from './waveform-drawing';

/** The timeline always shows at least this span, so a short recording is not stretched. */
const MIN_SPAN_US = 5_000_000;
const TICK_STEPS_S = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1_800, 3_600];
const MIN_TICK_GAP_PX = 72;
const MIN_CLIP_PX = 4;
const EFFECT_ROW_PX = 24;
/** The closest the timeline zooms in: about seventeen pixels a frame at 60 fps. */
const MAX_PX_PER_US = 1_000 / 1_000_000;
const ZOOM_STEP = 1.5;

export type EffectEdge = 'move' | 'start' | 'end';

interface TrimDrag {
  readonly clipId: string;
  readonly edge: 'start' | 'end';
  readonly originX: number;
  readonly deltaPx: number;
  /** The scale when the drag began, so the clips do not rescale under the pointer. */
  readonly pxPerUs: number;
}

interface EffectDrag {
  readonly effectId: string;
  readonly edge: EffectEdge;
  readonly originX: number;
  readonly deltaPx: number;
  readonly pxPerUs: number;
}

interface EffectBar {
  readonly clip: SnapshotClip;
  readonly effect: EffectDto;
  readonly startUs: number;
  readonly endUs: number;
  readonly row: number;
}

/** The previewed clips' effects as bars, each in the first row where it fits. */
function effectBars(project: ProjectSnapshot): readonly EffectBar[] {
  const spans = (previewTrack(project)?.clips ?? [])
    .flatMap((clip) =>
      clip.effects.flatMap((effect) => {
        const span = effectSpan(clip, effect);
        return span === undefined ? [] : [{ clip, effect, ...span }];
      }),
    )
    .sort((first, second) => first.startUs - second.startUs);
  const rowEnds: number[] = [];
  return spans.map((span) => {
    let row = rowEnds.findIndex((end) => end <= span.startUs);
    if (row === -1) {
      row = rowEnds.length;
    }
    rowEnds[row] = span.endUs;
    return { ...span, row };
  });
}

function effectLabel(effect: EffectDto): string {
  switch (effect.kind) {
    case 'zoom': {
      const scales = effect.poses.map((keyframe) => keyframe.value.scale);
      const lowest = Math.min(...scales).toFixed(1);
      const highest = Math.max(...scales).toFixed(1);
      return lowest === highest ? `Zoom ${highest}×` : `Zoom ${lowest}–${highest}×`;
    }
    case 'blur':
      return 'Blur';
    case 'annotation':
      return effect.shape.kind === 'text'
        ? `Text: ${effect.shape.text}`
        : effect.shape.kind === 'arrow'
          ? 'Arrow'
          : 'Box';
    case 'custom':
      return effect.type;
  }
}

export interface TimelineProps {
  readonly project: ProjectSnapshot;
  readonly playback: PlaybackStore;
  readonly waveforms: Readonly<Record<string, DecodedWaveform | null>>;
  /** Each recording's keyframes, small, by asset ID, as they arrive. */
  readonly filmstrips: ReadonlyMap<string, readonly FilmstripFrame[]>;
  readonly selectedClipId: string | null;
  readonly onSelect: (clipId: string | null) => void;
  /** A finished edge drag, in microseconds; the editor snaps and commits it. */
  readonly onTrim: (clipId: string, edge: 'start' | 'end', deltaUs: number) => void;
  readonly selectedEffectId: string | null;
  readonly onSelectEffect: (selection: { clipId: string; effectId: string } | null) => void;
  /** A finished drag of an effect or one of its edges, in microseconds. */
  readonly onRetimeEffect: (
    clipId: string,
    effectId: string,
    edge: EffectEdge,
    deltaUs: number,
  ) => void;
  /** The generated zoom selected, by its ID and the clip it shows over. */
  readonly selectedAutoZoom: { readonly clipId: string; readonly zoomId: string } | null;
  readonly onSelectAutoZoom: (selection: { clipId: string; zoomId: string } | null) => void;
}

function Playhead({
  playback,
  pxPerUs,
}: {
  readonly playback: PlaybackStore;
  readonly pxPerUs: number;
}) {
  const playheadUs = useStore(playback, (state) => state.playheadUs);
  return (
    <div
      className="playhead"
      data-testid="playhead"
      style={{ transform: `translateX(${playheadUs * pxPerUs}px)` }}
      aria-hidden="true"
    />
  );
}

/**
 * The pictures of the part of a clip on screen, a tile per keyframe's width,
 * on the clip's own grid so they stay put as the timeline scrolls.
 */
function ClipFilmstrip({
  frames,
  offsetPx,
  widthPx,
  clipSourceStartUs,
  sourceUsPerPx,
}: {
  readonly frames: readonly FilmstripFrame[];
  readonly offsetPx: number;
  readonly widthPx: number;
  readonly clipSourceStartUs: number;
  readonly sourceUsPerPx: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Drawn at the size it has on screen, which a fresh canvas may not have yet.
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }
    const observer = new ResizeObserver(([entry]) => setHeight(entry?.contentRect.height ?? 0));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const canvas = canvasRef.current;
    const first = frames[0];
    if (canvas === null || first === undefined || height <= 0) {
      return;
    }
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(widthPx * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    const context = canvas.getContext('2d');
    if (context === null) {
      return;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const tileWidth = (first.bitmap.width / first.bitmap.height) * height;
    for (const tile of filmstripTiles(
      frames,
      clipSourceStartUs,
      sourceUsPerPx,
      offsetPx,
      widthPx,
      tileWidth,
    )) {
      const bitmap = frames[tile.frame]?.bitmap;
      if (bitmap !== undefined) {
        context.drawImage(bitmap, tile.x, 0, tileWidth, height);
      }
    }
  }, [frames, offsetPx, widthPx, clipSourceStartUs, sourceUsPerPx, height]);
  return (
    <canvas
      ref={canvasRef}
      className="clip-filmstrip"
      style={{ left: offsetPx, width: widthPx }}
      aria-hidden="true"
      data-testid="clip-filmstrip"
    />
  );
}

/**
 * The waveform of the part of a clip on screen: a zoomed-in clip can be far
 * wider than a canvas may be, so only what shows is drawn.
 */
function ClipWaveform({
  waveform,
  offsetPx,
  widthPx,
  sourceStartUs,
  durationUs,
}: {
  readonly waveform: DecodedWaveform;
  /** Where the drawn part starts, from the clip's left edge. */
  readonly offsetPx: number;
  readonly widthPx: number;
  readonly sourceStartUs: number;
  readonly durationUs: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (canvasRef.current !== null) {
      drawWaveform(canvasRef.current, waveform, sourceStartUs, durationUs, '#8792c9');
    }
  }, [waveform, sourceStartUs, durationUs, widthPx]);
  return (
    <canvas
      ref={canvasRef}
      className="clip-waveform"
      style={{ left: offsetPx, width: widthPx }}
      aria-hidden="true"
    />
  );
}

/**
 * The editor's timeline strip: tracks, clips with their waveform, effects, a
 * ruler and the playhead. It fits the whole project, or zooms in (the
 * buttons, or Ctrl and the wheel) and scrolls, following the playhead while
 * it plays. Drags stay local until they finish; only then is one semantic
 * command sent (docs/state-management.md).
 */
export function Timeline({
  project,
  playback,
  waveforms,
  filmstrips,
  selectedClipId,
  onSelect,
  onTrim,
  selectedEffectId,
  onSelectEffect,
  onRetimeEffect,
  selectedAutoZoom,
  onSelectAutoZoom,
}: TimelineProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** Where to scroll once a zoom has rendered, so the anchored time stays put. */
  const pendingScroll = useRef<number | null>(null);
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [drag, setDrag] = useState<TrimDrag | null>(null);
  const [effectDrag, setEffectDrag] = useState<EffectDrag | null>(null);
  const [scrubbing, setScrubbing] = useState(false);

  useEffect(() => {
    const element = viewportRef.current;
    if (element === null) {
      return;
    }
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const spanUs = Math.max(project.durationUs, MIN_SPAN_US);
  const fitPxPerUs = width > 0 ? width / spanUs : 0;
  const maxZoom = fitPxPerUs > 0 ? Math.max(1, MAX_PX_PER_US / fitPxPerUs) : 1;
  const shownZoom = Math.min(zoom, maxZoom);
  const pxPerUs = drag?.pxPerUs ?? effectDrag?.pxPerUs ?? fitPxPerUs * shownZoom;
  const contentWidth = Math.max(width, spanUs * pxPerUs);
  const bars = effectBars(project);
  const autoBars = project.autoZoom.enabled ? autoZoomBars(project) : [];
  const effectRows = bars.reduce((rows, bar) => Math.max(rows, bar.row + 1), 0);
  const step =
    TICK_STEPS_S.find((seconds) => seconds * 1_000_000 * pxPerUs >= MIN_TICK_GAP_PX) ?? 3_600;
  const ticks =
    pxPerUs > 0
      ? ticksBetween(scrollLeft / pxPerUs, (scrollLeft + width) / pxPerUs, step * 1_000_000, spanUs)
      : [];

  const timeAt = (clientX: number): number => {
    const left = contentRef.current?.getBoundingClientRect().left ?? 0;
    return pxPerUs > 0 ? clamp((clientX - left) / pxPerUs, 0, project.durationUs) : 0;
  };

  /** Zooms by `factor`, keeping the time `anchorPx` into the viewport where it is on screen. */
  const zoomBy = (factor: number, anchorPx?: number) => {
    const viewport = viewportRef.current;
    if (viewport === null || fitPxPerUs === 0) {
      return;
    }
    const next = clamp(shownZoom * factor, 1, maxZoom);
    if (next === shownZoom) {
      return;
    }
    // Without a pointer, zoom about the playhead when it is in view, else the middle.
    const playheadPx = playback.getState().playheadUs * pxPerUs - viewport.scrollLeft;
    const anchor =
      anchorPx ?? (playheadPx >= 0 && playheadPx <= viewport.clientWidth ? playheadPx : width / 2);
    pendingScroll.current = anchoredScrollLeft(
      viewport.scrollLeft,
      anchor,
      pxPerUs,
      fitPxPerUs * next,
    );
    setZoom(next);
  };
  const zoomFromWheel = useEffectEvent((factor: number, anchorPx: number) =>
    zoomBy(factor, anchorPx),
  );

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    // The scroll event that follows updates `scrollLeft`.
    if (viewport !== null && pendingScroll.current !== null) {
      viewport.scrollLeft = pendingScroll.current;
      pendingScroll.current = null;
    }
  }, [zoom]);

  // Ctrl and the wheel zoom the timeline, not the page: the listener must not be passive.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) {
        event.preventDefault();
        zoomFromWheel(
          Math.exp(-event.deltaY * 0.002),
          event.clientX - viewport.getBoundingClientRect().left,
        );
      }
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, []);

  // A playhead that leaves the view, while playing or after a seek, brings the view along.
  useEffect(
    () =>
      playback.subscribe((state, previous) => {
        const viewport = viewportRef.current;
        if (viewport === null || scrubbing || state.playheadUs === previous.playheadUs) {
          return;
        }
        const x = state.playheadUs * pxPerUs;
        if (x < viewport.scrollLeft || x > viewport.scrollLeft + viewport.clientWidth - 16) {
          viewport.scrollLeft = Math.max(0, x - viewport.clientWidth * 0.2);
        }
      }),
    [playback, pxPerUs, scrubbing],
  );

  const startScrub = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    setScrubbing(true);
    playback.getState().seek(timeAt(event.clientX));
  };
  const scrubHandlers = {
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      if (scrubbing) {
        playback.getState().seek(timeAt(event.clientX));
      }
    },
    onPointerUp: () => setScrubbing(false),
    onPointerCancel: () => setScrubbing(false),
  };

  const startTrim = (
    event: ReactPointerEvent<HTMLElement>,
    clip: SnapshotClip,
    edge: 'start' | 'end',
  ) => {
    if (event.button !== 0) {
      return;
    }
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelect(clip.id);
    setDrag({ clipId: clip.id, edge, originX: event.clientX, deltaPx: 0, pxPerUs });
  };
  const trimHandlers = {
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      if (drag !== null) {
        setDrag({ ...drag, deltaPx: event.clientX - drag.originX });
      }
    },
    onPointerUp: () => {
      if (drag !== null && drag.pxPerUs > 0 && drag.deltaPx !== 0) {
        onTrim(drag.clipId, drag.edge, Math.round(drag.deltaPx / drag.pxPerUs));
      }
      setDrag(null);
    },
    onPointerCancel: () => setDrag(null),
  };

  const startEffectDrag = (
    event: ReactPointerEvent<HTMLElement>,
    bar: EffectBar,
    edge: EffectEdge,
  ) => {
    if (event.button !== 0) {
      return;
    }
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelectEffect({ clipId: bar.clip.id, effectId: bar.effect.id });
    if (edge === 'move') {
      playback.getState().seek(timeAt(event.clientX));
    }
    setEffectDrag({ effectId: bar.effect.id, edge, originX: event.clientX, deltaPx: 0, pxPerUs });
  };
  const effectDragHandlers = (bar: EffectBar) => ({
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      if (effectDrag !== null) {
        setEffectDrag({ ...effectDrag, deltaPx: event.clientX - effectDrag.originX });
      }
    },
    onPointerUp: () => {
      if (effectDrag !== null && effectDrag.pxPerUs > 0 && effectDrag.deltaPx !== 0) {
        onRetimeEffect(
          bar.clip.id,
          effectDrag.effectId,
          effectDrag.edge,
          Math.round(effectDrag.deltaPx / effectDrag.pxPerUs),
        );
      }
      setEffectDrag(null);
    },
    onPointerCancel: () => setEffectDrag(null),
  });

  return (
    <div className="timeline-shell">
      <div className="timeline-tools" role="group" aria-label="Timeline zoom">
        <button
          type="button"
          aria-label="Zoom the timeline out"
          disabled={shownZoom <= 1}
          onClick={() => zoomBy(1 / ZOOM_STEP)}
        >
          −
        </button>
        <button type="button" disabled={shownZoom <= 1} onClick={() => zoomBy(1 / shownZoom)}>
          Fit
        </button>
        <button
          type="button"
          aria-label="Zoom the timeline in"
          disabled={shownZoom >= maxZoom}
          onClick={() => zoomBy(ZOOM_STEP)}
        >
          +
        </button>
      </div>
      <div
        className="timeline"
        ref={viewportRef}
        role="group"
        aria-label="Timeline"
        data-testid="timeline"
        onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}
      >
        <div className="timeline-content" ref={contentRef} style={{ width: contentWidth }}>
          <div className="timeline-ruler" onPointerDown={startScrub} {...scrubHandlers}>
            {ticks.map((tickUs) => (
              <span
                key={tickUs}
                className="tick"
                style={{ transform: `translateX(${tickUs * pxPerUs}px)` }}
              >
                {formatTimecode(tickUs).replace(/\.00$/, '')}
              </span>
            ))}
          </div>

          {project.tracks.map((track) => (
            <div
              key={track.id}
              className={`timeline-track track-${track.kind}`}
              onPointerDown={(event) => {
                onSelect(null);
                startScrub(event);
              }}
              {...scrubHandlers}
            >
              {track.clips.map((clip) => {
                let left = clip.timelineStartUs * pxPerUs;
                let clipWidth = clip.durationUs * pxPerUs;
                if (drag?.clipId === clip.id) {
                  if (drag.edge === 'start') {
                    left += drag.deltaPx;
                    clipWidth -= drag.deltaPx;
                  } else {
                    clipWidth += drag.deltaPx;
                  }
                  clipWidth = Math.max(MIN_CLIP_PX, clipWidth);
                }
                const selected = clip.id === selectedClipId;
                const waveform = waveforms[clip.assetId];
                const filmstrip = filmstrips.get(clip.assetId) ?? [];
                // The waveform is drawn for the part of the clip on screen.
                const shownFrom = Math.max(left, scrollLeft);
                const shownTo = Math.min(left + clipWidth, scrollLeft + width);
                return (
                  <div
                    key={clip.id}
                    className={`clip${selected ? ' selected' : ''}${filmstrip.length > 0 ? ' with-filmstrip' : ''}`}
                    style={{ left, width: clipWidth }}
                    role="button"
                    tabIndex={0}
                    aria-pressed={selected}
                    aria-label={`Clip ${formatTimecode(clip.timelineStartUs)} to ${formatTimecode(clipEndUs(clip))}`}
                    data-testid="timeline-clip"
                    onPointerDown={(event) => {
                      if (event.button !== 0) {
                        return;
                      }
                      event.stopPropagation();
                      onSelect(clip.id);
                      playback.getState().seek(timeAt(event.clientX));
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        onSelect(clip.id);
                      }
                    }}
                  >
                    {filmstrip.length > 0 && shownTo > shownFrom && (
                      <ClipFilmstrip
                        frames={filmstrip}
                        offsetPx={shownFrom - left}
                        widthPx={shownTo - shownFrom}
                        clipSourceStartUs={clip.sourceStartUs}
                        sourceUsPerPx={clip.speed / pxPerUs}
                      />
                    )}
                    {waveform !== undefined && waveform !== null && shownTo > shownFrom && (
                      <ClipWaveform
                        waveform={waveform}
                        offsetPx={shownFrom - left}
                        widthPx={shownTo - shownFrom}
                        sourceStartUs={
                          clip.sourceStartUs + ((shownFrom - left) / pxPerUs) * clip.speed
                        }
                        durationUs={((shownTo - shownFrom) / pxPerUs) * clip.speed}
                      />
                    )}
                    <span
                      className="trim-handle trim-start"
                      aria-hidden="true"
                      onPointerDown={(event) => startTrim(event, clip, 'start')}
                      {...trimHandlers}
                    />
                    <span
                      className="trim-handle trim-end"
                      aria-hidden="true"
                      onPointerDown={(event) => startTrim(event, clip, 'end')}
                      {...trimHandlers}
                    />
                  </div>
                );
              })}
            </div>
          ))}

          {autoBars.length > 0 && (
            <div
              className="timeline-auto"
              onPointerDown={(event) => {
                onSelectAutoZoom(null);
                startScrub(event);
              }}
              {...scrubHandlers}
            >
              {autoBars.map((bar) => {
                const selected =
                  selectedAutoZoom?.clipId === bar.clip.id &&
                  selectedAutoZoom.zoomId === bar.zoom.id;
                const classes = ['auto-bar'];
                if (selected) {
                  classes.push('selected');
                }
                if (bar.disabled) {
                  classes.push('off');
                }
                return (
                  <div
                    key={`${bar.clip.id}-${bar.zoom.id}`}
                    className={classes.join(' ')}
                    style={{
                      left: bar.startUs * pxPerUs,
                      width: Math.max(MIN_CLIP_PX, (bar.endUs - bar.startUs) * pxPerUs),
                    }}
                    role="button"
                    tabIndex={0}
                    aria-pressed={selected}
                    aria-label={`Automatic zoom ${formatTimecode(bar.startUs)} to ${formatTimecode(bar.endUs)}${bar.disabled ? ', turned off' : ''}`}
                    data-testid="auto-zoom-bar"
                    onPointerDown={(event) => {
                      if (event.button !== 0) {
                        return;
                      }
                      event.stopPropagation();
                      onSelectAutoZoom({ clipId: bar.clip.id, zoomId: bar.zoom.id });
                      playback.getState().seek(timeAt(event.clientX));
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        onSelectAutoZoom({ clipId: bar.clip.id, zoomId: bar.zoom.id });
                      }
                    }}
                  >
                    <span className="effect-label">Auto {project.autoZoom.scale.toFixed(1)}×</span>
                    {(project.autoZoom.turn3d ?? 0) > 0 && (
                      <span className="chip-3d" aria-hidden="true">
                        3D
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {bars.length > 0 && (
            <div
              className="timeline-effects"
              style={{ height: effectRows * EFFECT_ROW_PX + 8 }}
              onPointerDown={(event) => {
                onSelectEffect(null);
                startScrub(event);
              }}
              {...scrubHandlers}
            >
              {bars.map((bar) => {
                let left = bar.startUs * pxPerUs;
                let barWidth = (bar.endUs - bar.startUs) * pxPerUs;
                if (effectDrag?.effectId === bar.effect.id) {
                  const { edge, deltaPx } = effectDrag;
                  if (edge !== 'end') {
                    left += deltaPx;
                  }
                  if (edge === 'start') {
                    barWidth -= deltaPx;
                  } else if (edge === 'end') {
                    barWidth += deltaPx;
                  }
                  barWidth = Math.max(MIN_CLIP_PX, barWidth);
                }
                const selected = bar.effect.id === selectedEffectId;
                const label = effectLabel(bar.effect);
                const in3d = bar.effect.kind === 'zoom' && zoomIs3d(bar.effect);
                const handlers = effectDragHandlers(bar);
                const classes = ['effect-bar', `effect-${bar.effect.kind}`];
                if (selected) {
                  classes.push('selected');
                }
                if (!bar.effect.enabled) {
                  classes.push('off');
                }
                return (
                  <div
                    key={bar.effect.id}
                    className={classes.join(' ')}
                    style={{ left, width: barWidth, top: 4 + bar.row * EFFECT_ROW_PX }}
                    role="button"
                    tabIndex={0}
                    aria-pressed={selected}
                    aria-label={`${label}${in3d ? ' in 3D' : ''} ${formatTimecode(bar.startUs)} to ${formatTimecode(bar.endUs)}`}
                    data-testid="effect-bar"
                    onPointerDown={(event) => startEffectDrag(event, bar, 'move')}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        onSelectEffect({ clipId: bar.clip.id, effectId: bar.effect.id });
                      }
                    }}
                    {...handlers}
                  >
                    <span className="effect-label">{label}</span>
                    {in3d && (
                      <span className="chip-3d" aria-hidden="true">
                        3D
                      </span>
                    )}
                    {effectKeyframes(bar.effect).length > 1 &&
                      effectKeyframes(bar.effect).map((keyframe, index) => {
                        const atUs = timelineTimeUs(bar.clip, keyframe.timestampUs);
                        return atUs >= bar.startUs && atUs <= bar.endUs ? (
                          <span
                            key={index}
                            className="keyframe-tick"
                            style={{ left: (atUs - bar.startUs) * pxPerUs }}
                            aria-hidden="true"
                          />
                        ) : null;
                      })}
                    {/* A handle's captured moves bubble to the bar's handlers. */}
                    <span
                      className="trim-handle trim-start"
                      aria-hidden="true"
                      onPointerDown={(event) => startEffectDrag(event, bar, 'start')}
                    />
                    <span
                      className="trim-handle trim-end"
                      aria-hidden="true"
                      onPointerDown={(event) => startEffectDrag(event, bar, 'end')}
                    />
                  </div>
                );
              })}
            </div>
          )}

          <Playhead playback={playback} pxPerUs={pxPerUs} />
        </div>
      </div>
    </div>
  );
}
