import { useEffect, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';

import {
  asAssetId,
  asEffectId,
  asTimestampUs,
  type ClipId,
  type CanvasStyleDto,
  type CursorSettingsDto,
  type EffectDto,
  type ProjectSnapshot,
} from '@usee/contracts';
import { cursorAt, pointerTimeOrigin, presetKeyframes, type CameraPreset } from '@usee/domain';

import { messageFor } from '../messages';
import type { SettingsStore } from '../settings/settings-store';
import { autoZoomBars } from './auto-zoom';
import { AutoZoomInspector, AutoZoomPanel } from './AutoZoomPanel';
import { CameraMoveButtons, DEFAULT_CAMERA_MOVE } from './camera-moves';
import { CanvasPanel } from './CanvasPanel';
import { ClipPanel } from './ClipPanel';
import { CursorPanel } from './CursorPanel';
import { draggedEffect, newAnnotation, newBlur, newZoom } from './effect-editing';
import { EffectInspector } from './EffectInspector';
import { ExportPanel } from './ExportPanel';
import type { PlaybackStore } from './playback-store';
import { Player } from './Player';
import { AnnotationEditor, BlurMaskEditor, ZoomFrameEditor } from './PreviewOverlays';
import type { ProjectStore } from './project-store';
import { formatTimecode } from './timecode';
import { Timeline, type EffectEdge } from './Timeline';
import { useCursorPaths } from './use-cursor-paths';
import { useFilmstrips } from './use-filmstrips';
import { usePictureAnalysis } from './use-picture-analysis';
import { useProjectThumbnail } from './use-project-thumbnail';
import { arrowTo, Icon, type IconName } from './ui';
import {
  clamp,
  clipAt,
  clipAtOrAfter,
  clipEndUs,
  frameDurationUs,
  previewTrack,
  snapToFrame,
  sourceTimeUs,
  type SnapshotClip,
} from './timeline-math';

interface EffectSelection {
  readonly clipId: string;
  readonly effectId: string;
}

type InspectorTab = 'edit' | 'canvas' | 'cursor' | 'camera';

/** The inspector's tabs: what is selected, then the project-wide looks. */
const INSPECTOR_TABS: readonly {
  readonly id: InspectorTab;
  readonly label: string;
  readonly icon: IconName;
}[] = [
  { id: 'edit', label: 'Edit', icon: 'edit' },
  { id: 'canvas', label: 'Canvas', icon: 'canvas' },
  { id: 'cursor', label: 'Cursor', icon: 'cursor' },
  { id: 'camera', label: '3D camera', icon: 'cube' },
];

function findClip(project: ProjectSnapshot, clipId: string | null): SnapshotClip | undefined {
  return clipId === null
    ? undefined
    : project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === clipId);
}

function findEffect(
  project: ProjectSnapshot,
  selection: EffectSelection | null,
): { readonly clip: SnapshotClip; readonly effect: EffectDto } | undefined {
  const clip = selection === null ? undefined : findClip(project, selection.clipId);
  const effect = clip?.effects.find((candidate) => candidate.id === selection?.effectId);
  return clip === undefined || effect === undefined ? undefined : { clip, effect };
}

function SaveStatus({
  project,
  onRetry,
}: {
  readonly project: ProjectSnapshot;
  readonly onRetry: () => void;
}) {
  switch (project.saveState) {
    case 'saved':
      return (
        <p className="save-status" data-testid="save-status">
          Saved
        </p>
      );
    case 'saving':
      return (
        <p className="save-status" data-testid="save-status">
          Saving…
        </p>
      );
    case 'failed':
      return (
        <p className="save-status save-failed" role="alert" data-testid="save-status">
          Not saved.{' '}
          {project.saveError === null ? '' : messageFor(project.saveError.userMessageKey)}{' '}
          <button type="button" onClick={onRetry}>
            Try again
          </button>
        </p>
      );
  }
}

function Timecode({
  playback,
  durationUs,
}: {
  readonly playback: PlaybackStore;
  readonly durationUs: number;
}) {
  const playheadUs = useStore(playback, (state) => state.playheadUs);
  return (
    <p className="timecode" data-testid="timecode">
      {formatTimecode(playheadUs)} / {formatTimecode(durationUs)}
    </p>
  );
}

/**
 * The editor for the open project: preview, timeline and the edit commands.
 * Every change goes to main as one semantic command; the view follows the
 * snapshots main sends back.
 */
export function EditorView({
  store,
  playback,
  settings,
  backLabel,
}: {
  readonly store: ProjectStore;
  readonly playback: PlaybackStore;
  readonly settings: SettingsStore;
  /** The page closing the project returns to. */
  readonly backLabel: string;
}) {
  const project = useStore(store, (state) => state.project);
  const error = useStore(store, (state) => state.error);
  const waveforms = useStore(store, (state) => state.waveforms);
  const pointerTracks = useStore(store, (state) => state.pointerTracks);
  const playing = useStore(playback, (state) => state.playing);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedEffect, setSelectedEffect] = useState<EffectSelection | null>(null);
  const [selectedAuto, setSelectedAuto] = useState<{ clipId: string; zoomId: string } | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [tab, setTab] = useState<InspectorTab>('edit');

  // One selection at a time: a clip, an effect or a generated zoom.
  const selectClip = (clipId: string | null) => {
    setSelectedClipId(clipId);
    if (clipId !== null) {
      setTab('edit');
      setSelectedEffect(null);
      setSelectedAuto(null);
    }
  };
  const selectEffect = (selection: EffectSelection | null) => {
    setSelectedEffect(selection);
    if (selection !== null) {
      setTab('edit');
      setSelectedClipId(null);
      setSelectedAuto(null);
    }
  };
  const selectAuto = (selection: { clipId: string; zoomId: string } | null) => {
    setSelectedAuto(selection);
    if (selection !== null) {
      setTab('edit');
      setSelectedClipId(null);
      setSelectedEffect(null);
    }
  };

  // The timeline shows each recording's keyframes, read in the background.
  const filmstrips = useFilmstrips(project);

  // A project the list shows without a picture gets one, made in the background.
  const openPath = useStore(store, (state) => state.openPath);
  const listedWithThumbnail = useStore(store, (state) =>
    state.recent.some(
      (summary) => summary.projectPath === openPath && summary.thumbnail !== undefined,
    ),
  );
  useProjectThumbnail(
    project,
    openPath !== null && !listedWithThumbnail,
    () => void store.getState().refreshRecent(),
  );

  // Picture focus is a setting for every recording; the editor reads the picture it needs.
  const pictureFocus = useStore(
    settings,
    (state) => state.settings?.analysis?.pictureFocus === true,
  );
  const picture = usePictureAnalysis(
    project,
    pictureFocus && project !== null && project.hasPointer && project.autoZoom.enabled,
  );

  // The cursor as drawn: each recorded pointer stream, smoothed as the project says.
  const smoothing = project?.cursor.smoothing ?? 0;
  const cursorPaths = useCursorPaths(pointerTracks, smoothing);

  const assetsWithAudio = (project?.assets ?? [])
    .filter((asset) => asset.hasAudio)
    .map((asset) => asset.id);
  const assetsKey = assetsWithAudio.join('|');
  useEffect(() => {
    for (const assetId of assetsKey === '' ? [] : assetsKey.split('|')) {
      void store.getState().loadWaveform(asAssetId(assetId));
    }
  }, [assetsKey, store]);

  const streamsKey = [
    ...new Set((project?.assets ?? []).flatMap((asset) => asset.pointer?.streamId ?? [])),
  ].join('|');
  useEffect(() => {
    for (const streamId of streamsKey === '' ? [] : streamsKey.split('|')) {
      void store.getState().loadPointerTrack(asAssetId(streamId));
    }
  }, [streamsKey, store]);

  // Each project opens paused at its first frame (recorded clips can start a frame or two in).
  const projectId = project?.projectId;
  useEffect(() => {
    if (projectId === undefined) {
      return;
    }
    const opened = store.getState().project;
    const first = opened === null ? undefined : clipAtOrAfter(previewTrack(opened), 0);
    playback.getState().setPlaying(false);
    playback.getState().seek(first?.timelineStartUs ?? 0);
  }, [projectId, store, playback]);

  // After an edit the timeline may be shorter than where the playhead was.
  const durationUs = project?.durationUs ?? 0;
  useEffect(() => {
    if (playback.getState().playheadUs > durationUs) {
      playback.getState().seek(durationUs);
    }
  }, [durationUs, playback]);

  const selectedClip = project === null ? undefined : findClip(project, selectedClipId);
  const editing = project === null ? undefined : findEffect(project, selectedEffect);
  const toleranceUs = project === null ? 0 : frameDurationUs(project.frameRate) / 2;

  /** The clip a command applies to: the selected one, else the one under the playhead. */
  const targetClip = (): SnapshotClip | undefined => {
    if (project === null) {
      return undefined;
    }
    const { playheadUs } = playback.getState();
    const selected = findClip(project, selectedClipId);
    if (selected !== undefined) {
      return selected;
    }
    return clipAt(previewTrack(project), playheadUs);
  };

  const togglePlay = () => {
    const state = playback.getState();
    if (state.playing) {
      state.setPlaying(false);
      return;
    }
    const track = project === null ? undefined : previewTrack(project);
    if (project === null || track === undefined) {
      return;
    }
    // From the end, start over; from a gap, start at the next clip.
    const from =
      state.playheadUs >= project.durationUs - frameDurationUs(project.frameRate) / 2
        ? 0
        : state.playheadUs;
    const clip = clipAtOrAfter(track, from);
    if (clip === undefined) {
      return;
    }
    const start = Math.max(from, clip.timelineStartUs);
    if (start !== state.playheadUs) {
      state.seek(start);
    }
    state.setPlaying(true);
  };

  const split = () => {
    if (project === null) {
      return;
    }
    const { playheadUs } = playback.getState();
    const selected = findClip(project, selectedClipId);
    const clip =
      selected !== undefined &&
      selected.timelineStartUs < playheadUs &&
      playheadUs < clipEndUs(selected)
        ? selected
        : clipAt(previewTrack(project), playheadUs);
    if (clip === undefined) {
      setHint('Move the playhead over a clip to split it.');
      return;
    }
    setHint(null);
    playback.getState().setPlaying(false);
    void store.getState().edit({
      type: 'split',
      clipId: clip.id,
      atUs: asTimestampUs(snapToFrame(playheadUs, project.frameRate)),
    });
  };

  /** Where the cursor is at `sourceUs` of a clip's media, when a pointer was recorded with it. */
  const cursorTarget = (clip: SnapshotClip, sourceUs: number) => {
    const pointer = project?.assets.find((asset) => asset.id === clip.assetId)?.pointer ?? null;
    const path = pointer === null ? undefined : cursorPaths.get(pointer.streamId);
    const cursor =
      pointer === null || path === undefined
        ? undefined
        : cursorAt(path, pointerTimeOrigin(pointer) + sourceUs);
    return cursor === undefined ? undefined : { x: cursor.x, y: cursor.y };
  };

  /**
   * Adds a zoom (toward the cursor, with a 3D move if one is named), a blur or
   * an annotation at the playhead, and selects it.
   */
  const addEffect = (kind: 'zoom' | 'blur' | 'annotation', move?: CameraPreset) => {
    if (project === null) {
      return;
    }
    const { playheadUs, setPlaying } = playback.getState();
    const clip = clipAt(previewTrack(project), playheadUs);
    if (clip === undefined) {
      setHint('Move the playhead over a clip to add an effect there.');
      return;
    }
    setHint(null);
    setPlaying(false);
    const sourceUs = sourceTimeUs(clip, playheadUs);
    const id = crypto.randomUUID();
    const zoom =
      kind === 'zoom'
        ? newZoom(id, clip, sourceUs, cursorTarget(clip, sourceUs) ?? { x: 0.5, y: 0.5 })
        : undefined;
    const effect =
      zoom === undefined
        ? kind === 'annotation'
          ? newAnnotation(id, clip, sourceUs)
          : newBlur(id, clip, sourceUs)
        : move === undefined
          ? zoom
          : { ...zoom, poses: presetKeyframes(zoom, move) };
    selectEffect({ clipId: clip.id, effectId: id });
    void store.getState().edit({ type: 'add-effect', clipId: clip.id, effect });
  };

  const updateEffect = (clipId: ClipId, effect: EffectDto) => {
    void store.getState().edit({ type: 'update-effect', clipId, effect });
  };

  const removeEffect = () => {
    if (editing === undefined) {
      return;
    }
    setSelectedEffect(null);
    void store.getState().edit({
      type: 'remove-effect',
      clipId: editing.clip.id,
      effectId: editing.effect.id,
    });
  };

  /** A finished drag on the timeline: moves an effect or one of its ends, snapped to frames. */
  const moveEffect = (clipId: string, effectId: string, edge: EffectEdge, deltaUs: number) => {
    const found = project === null ? undefined : findEffect(project, { clipId, effectId });
    if (project === null || found === undefined) {
      return;
    }
    const moved = draggedEffect(
      found.clip,
      found.effect,
      edge,
      snapToFrame(deltaUs, project.frameRate),
    );
    if (moved !== undefined) {
      updateEffect(found.clip.id, moved);
    }
  };

  const setCursor = (settings: CursorSettingsDto) => {
    void store.getState().edit({ type: 'set-cursor', settings });
  };

  const setCanvas = (style: CanvasStyleDto) => {
    void store.getState().edit({ type: 'set-canvas', style });
  };

  // A generated zoom can be selected only while the layer shows on the timeline.
  const autoBars = project === null ? [] : autoZoomBars(project);
  const autoBar = autoBars.find(
    (bar) =>
      project?.autoZoom.enabled === true &&
      bar.clip.id === selectedAuto?.clipId &&
      bar.zoom.id === selectedAuto.zoomId,
  );
  const setGeneratedZoom = (zoomId: string, enabled: boolean) => {
    void store.getState().edit({ type: 'set-generated-zoom', zoomId, enabled });
  };
  /**
   * The selected generated zoom becomes the user's own, to change as any zoom:
   * a copy on each clip it shows over, the copy on this clip selected.
   */
  const takeOverAuto = () => {
    if (autoBar === undefined) {
      return;
    }
    const effects = autoBars
      .filter((bar) => bar.zoom.id === autoBar.zoom.id)
      .map((bar) => ({
        clipId: bar.clip.id,
        effect: { ...bar.effect, id: asEffectId(crypto.randomUUID()) },
      }));
    const selected = effects.find(({ clipId }) => clipId === autoBar.clip.id);
    if (selected !== undefined) {
      selectEffect({ clipId: selected.clipId, effectId: selected.effect.id });
    }
    void store.getState().edit({
      type: 'take-over-generated-zoom',
      zoomId: autoBar.zoom.id,
      effects,
    });
  };

  const remove = () => {
    if (editing !== undefined) {
      removeEffect();
      return;
    }
    if (autoBar !== undefined) {
      setGeneratedZoom(autoBar.zoom.id, false);
      return;
    }
    const clip = targetClip();
    if (clip === undefined) {
      setHint('Select a clip to delete it.');
      return;
    }
    setHint(null);
    playback.getState().setPlaying(false);
    setSelectedClipId(null);
    void store.getState().edit({ type: 'delete', clipId: clip.id });
  };

  const trim = (clipId: string, edge: 'start' | 'end', deltaUs: number) => {
    if (project === null) {
      return;
    }
    const clip = findClip(project, clipId);
    const snapped = snapToFrame(deltaUs, project.frameRate);
    if (clip !== undefined && snapped !== 0) {
      void store.getState().edit({ type: 'trim', clipId: clip.id, edge, deltaUs: snapped });
    }
  };

  /** `[` and `]`: trims the selected clip's start or end to the playhead. */
  const trimToPlayhead = (edge: 'start' | 'end') => {
    const clip = project === null ? undefined : findClip(project, selectedClipId);
    const { playheadUs } = playback.getState();
    if (clip === undefined || playheadUs <= clip.timelineStartUs || playheadUs >= clipEndUs(clip)) {
      setHint('Select a clip and put the playhead inside it to trim to the playhead.');
      return;
    }
    setHint(null);
    trim(clip.id, edge, playheadUs - (edge === 'start' ? clip.timelineStartUs : clipEndUs(clip)));
  };

  const stepFrames = (direction: -1 | 1, wholeSecond: boolean) => {
    if (project === null) {
      return;
    }
    const { playheadUs, seek, setPlaying } = playback.getState();
    setPlaying(false);
    const stepUs = wholeSecond ? 1_000_000 : frameDurationUs(project.frameRate);
    seek(
      clamp(snapToFrame(playheadUs + direction * stepUs, project.frameRate), 0, project.durationUs),
    );
  };

  // Keyboard shortcuts while the editor is open; the latest handlers each render.
  const shortcuts = { togglePlay, split, remove, trimToPlayhead, stepFrames, addEffect };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      const state = store.getState();
      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === 'z' || key === 'y') {
          event.preventDefault();
          void (key === 'y' || event.shiftKey ? state.redo() : state.undo());
        }
        return;
      }
      switch (event.key) {
        case ' ':
          if (target instanceof HTMLButtonElement) {
            return; // the button's own click
          }
          event.preventDefault();
          shortcuts.togglePlay();
          return;
        case 's':
        case 'S':
          shortcuts.split();
          return;
        case 'z':
        case 'Z':
          shortcuts.addEffect('zoom');
          return;
        case 'b':
        case 'B':
          shortcuts.addEffect('blur');
          return;
        case 't':
        case 'T':
          shortcuts.addEffect('annotation');
          return;
        case 'Escape':
          setSelectedClipId(null);
          setSelectedEffect(null);
          setSelectedAuto(null);
          return;
        case 'Delete':
        case 'Backspace':
          shortcuts.remove();
          return;
        case '[':
          shortcuts.trimToPlayhead('start');
          return;
        case ']':
          shortcuts.trimToPlayhead('end');
          return;
        case 'ArrowLeft':
        case 'ArrowRight':
          event.preventDefault();
          shortcuts.stepFrames(event.key === 'ArrowLeft' ? -1 : 1, event.shiftKey);
          return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  if (project === null) {
    return null;
  }

  // While an effect is selected, the picture shows the whole frame with the effect's handles.
  let overlay: ReactNode = undefined;
  if (editing !== undefined) {
    const { clip, effect } = editing;
    if (effect.kind === 'zoom') {
      overlay = (
        <ZoomFrameEditor
          zoom={effect}
          clip={clip}
          playback={playback}
          toleranceUs={toleranceUs}
          onChange={(next) => updateEffect(clip.id, next)}
        />
      );
    } else if (effect.kind === 'annotation') {
      overlay = (
        <AnnotationEditor annotation={effect} onChange={(next) => updateEffect(clip.id, next)} />
      );
    } else if (effect.kind === 'blur') {
      overlay = (
        <BlurMaskEditor
          blur={effect}
          clip={clip}
          playback={playback}
          toleranceUs={toleranceUs}
          onChange={(next) => updateEffect(clip.id, next)}
        />
      );
    }
  }

  return (
    <section className="editor" aria-labelledby="editor-title">
      <header className="editor-header">
        <button type="button" className="ghost back" onClick={() => void store.getState().close()}>
          <Icon name="back" />
          {backLabel}
        </button>
        <h2 id="editor-title">{project.title}</h2>
        <SaveStatus project={project} onRetry={() => void store.getState().save()} />
        <div className="actions">
          <button
            type="button"
            className="icon-button"
            aria-label="Undo"
            title="Undo (Ctrl+Z)"
            onClick={() => void store.getState().undo()}
            disabled={!project.canUndo}
            aria-keyshortcuts="Control+Z"
          >
            <Icon name="undo" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Redo"
            title="Redo (Ctrl+Shift+Z)"
            onClick={() => void store.getState().redo()}
            disabled={!project.canRedo}
            aria-keyshortcuts="Control+Shift+Z"
          >
            <Icon name="redo" />
          </button>
          <ExportPanel settings={settings} />
        </div>
      </header>

      <div className="editor-body">
        <div className="player-area">
          <Player
            project={project}
            playback={playback}
            cursorPaths={cursorPaths}
            fullFrame={editing !== undefined}
          >
            {overlay}
          </Player>
        </div>
        <aside className="inspector" aria-label="Inspector">
          <div
            className="inspector-tabs"
            role="tablist"
            aria-label="Settings"
            onKeyDown={(event) =>
              arrowTo(
                event,
                INSPECTOR_TABS.map(({ id }) => id),
                tab,
                setTab,
                '[aria-selected="true"]',
              )
            }
          >
            {INSPECTOR_TABS.map(({ id, label, icon }) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`tab-${id}`}
                aria-selected={tab === id}
                aria-controls="inspector-panel"
                tabIndex={tab === id ? 0 : -1}
                className={tab === id ? 'inspector-tab selected' : 'inspector-tab'}
                onClick={() => setTab(id)}
              >
                <Icon name={icon} />
                <span>{label}</span>
              </button>
            ))}
          </div>
          <div
            className="inspector-panel"
            role="tabpanel"
            id="inspector-panel"
            aria-labelledby={`tab-${tab}`}
          >
            {tab === 'edit' &&
              (editing !== undefined ? (
                <EffectInspector
                  effect={editing.effect}
                  clip={editing.clip}
                  playback={playback}
                  toleranceUs={toleranceUs}
                  onChange={(effect) => updateEffect(editing.clip.id, effect)}
                  onRemove={removeEffect}
                />
              ) : autoBar !== undefined ? (
                <AutoZoomInspector
                  bar={autoBar}
                  onToggle={(enabled) => setGeneratedZoom(autoBar.zoom.id, enabled)}
                  onTakeOver={takeOverAuto}
                />
              ) : selectedClip !== undefined ? (
                <ClipPanel
                  clip={selectedClip}
                  onSpeed={(speed) =>
                    void store
                      .getState()
                      .edit({ type: 'set-clip-speed', clipId: selectedClip.id, speed })
                  }
                />
              ) : (
                <div className="empty-state">
                  <p>Nothing selected</p>
                  <p className="field-note">
                    Select a clip or an effect on the timeline to change it, or add a zoom (Z), a
                    blur (B) or an annotation (T) at the playhead.
                  </p>
                </div>
              ))}
            {tab === 'canvas' && <CanvasPanel style={project.canvas} onChange={setCanvas} />}
            {tab === 'cursor' && (
              <CursorPanel
                settings={project.cursor}
                hasPointer={project.hasPointer}
                onChange={setCursor}
              />
            )}
            {tab === 'camera' && (
              <AutoZoomPanel
                moves={
                  <CameraMoveButtons
                    onApply={(move) => {
                      if (editing?.effect.kind === 'zoom') {
                        const zoom = editing.effect;
                        updateEffect(editing.clip.id, {
                          ...zoom,
                          poses: presetKeyframes(zoom, move),
                        });
                      } else {
                        addEffect('zoom', move);
                      }
                    }}
                  />
                }
                movesNote={
                  editing?.effect.kind === 'zoom'
                    ? 'Each writes the selected zoom’s keyframes in one step; change any of them after.'
                    : 'Each adds a zoom with that move at the playhead; select it to aim and fine-tune it.'
                }
                settings={project.autoZoom}
                zoomCount={new Set(autoBars.map((bar) => bar.zoom.id)).size}
                hasPointer={project.hasPointer}
                pictureFocus={pictureFocus}
                picture={picture}
                onPictureFocus={(on) =>
                  void settings.getState().update({ analysis: { pictureFocus: on } })
                }
                onChange={(settings) =>
                  void store.getState().edit({ type: 'set-auto-zoom', ...settings })
                }
              />
            )}
          </div>
        </aside>
      </div>

      <div className="editor-toolbar">
        <button
          type="button"
          className="play-button"
          onClick={togglePlay}
          aria-label={playing ? 'Pause' : 'Play'}
          title={playing ? 'Pause (Space)' : 'Play (Space)'}
          aria-keyshortcuts="Space"
        >
          <Icon name={playing ? 'pause' : 'play'} />
        </button>
        <Timecode playback={playback} durationUs={project.durationUs} />
        <div className="tool-group" role="group" aria-label="Edit at the playhead">
          <button
            type="button"
            className="tool"
            onClick={() => addEffect('zoom')}
            aria-keyshortcuts="Z"
            title="Add a zoom at the playhead (Z)"
          >
            <Icon name="zoom" />
            Add zoom
          </button>
          <button
            type="button"
            className="tool tool-3d"
            onClick={() => addEffect('zoom', DEFAULT_CAMERA_MOVE)}
            title="Add a zoom that swings in 3D at the playhead; the 3D camera tab has more moves"
          >
            <Icon name="cube" />
            Add 3D zoom
          </button>
          <button
            type="button"
            className="tool"
            onClick={() => addEffect('blur')}
            aria-keyshortcuts="B"
            title="Add a blur at the playhead (B)"
          >
            <Icon name="blur" />
            Add blur
          </button>
          <button
            type="button"
            className="tool"
            onClick={() => addEffect('annotation')}
            aria-keyshortcuts="T"
            title="Add words, an arrow or a box at the playhead (T)"
          >
            <Icon name="text" />
            Annotate
          </button>
          <button
            type="button"
            className="tool"
            onClick={split}
            aria-keyshortcuts="S"
            title="Split the clip at the playhead (S)"
          >
            <Icon name="split" />
            Split
          </button>
          <button
            type="button"
            className="tool danger"
            onClick={remove}
            disabled={selectedClip === undefined}
            aria-keyshortcuts="Delete"
            title="Delete the selected clip (Delete)"
          >
            <Icon name="trash" />
            Delete clip
          </button>
        </div>
      </div>

      <Timeline
        project={project}
        playback={playback}
        waveforms={waveforms}
        filmstrips={filmstrips}
        selectedClipId={selectedClip?.id ?? null}
        onSelect={selectClip}
        onTrim={trim}
        selectedEffectId={editing?.effect.id ?? null}
        onSelectEffect={selectEffect}
        onRetimeEffect={moveEffect}
        selectedAutoZoom={autoBar === undefined ? null : selectedAuto}
        onSelectAutoZoom={selectAuto}
      />

      <p className="editor-hint">
        {hint ??
          'Space plays · S splits at the playhead · Z adds a zoom, B a blur, T an annotation · Delete removes what is selected · drag an edge, or [ and ], to trim · ← → step a frame · Ctrl + wheel zooms the timeline'}
      </p>
      {error !== undefined && (
        <p className="status status-error" role="alert">
          {messageFor(error.userMessageKey)} Support reference: {error.correlationId}{' '}
          <button type="button" onClick={() => store.getState().dismissError()}>
            Dismiss
          </button>
        </p>
      )}
    </section>
  );
}
