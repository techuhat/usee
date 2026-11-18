import { use, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useStore } from 'zustand';

import type { EffectDto, Point, Rectangle } from '@usee/contracts';
import {
  applyHomography,
  cardTransform,
  clampView,
  MAX_CAMERA_TURN_DEGREES,
  type CameraRotation,
} from '@usee/domain';

import {
  blurMaskAt,
  editBlurMask,
  editZoomPose,
  editZoomRotation,
  zoomPoseAt,
  type AnnotationDto,
  type AnnotationShapeDto,
  type BlurDto,
  type ZoomDto,
  type ZoomPoseDto,
} from './effect-editing';
import { PictureAspect } from './picture-aspect';
import type { PlaybackStore } from './playback-store';
import { clamp, sourceTimeUs, type SnapshotClip } from './timeline-math';

/** The smallest blur box a drag leaves, as a share of the frame. */
const MIN_MASK = 0.02;

const percent = (value: number) => `${value * 100}%`;

/** How far a drag across the whole picture turns it, in degrees. */
const TURN_PER_PICTURE = 60;
const CARD_CORNERS = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
] as const;
const FLAT: CameraRotation = { x: 0, y: 0, z: 0 };

const sameTurn = (first: CameraRotation, second: CameraRotation) =>
  first.x === second.x && first.y === second.y && first.z === second.z;

/** A drag on the turn handle from `origin`: across turns the picture, up and down tilts it. */
function draggedTurn(start: CameraRotation, origin: Point, point: Point): CameraRotation {
  const limit = (degrees: number) =>
    Math.round(clamp(degrees, -MAX_CAMERA_TURN_DEGREES, MAX_CAMERA_TURN_DEGREES));
  return {
    x: limit(start.x + (origin.y - point.y) * TURN_PER_PICTURE),
    y: limit(start.y + (point.x - origin.x) * TURN_PER_PICTURE),
    z: start.z,
  };
}

/**
 * A gesture's value, shown from the moment it starts until the project
 * reports a change: after a commit it stays up while the edit makes its
 * round trip, instead of flicking back to what was there before.
 */
interface Draft<Value> {
  /** What the project showed when the gesture began. */
  readonly base: Value;
  readonly value: Value;
  readonly active: boolean;
}

const samePoint = (first: Point, second: Point) => first.x === second.x && first.y === second.y;
const sameBox = (first: Rectangle, second: Rectangle) =>
  samePoint(first, second) && first.width === second.width && first.height === second.height;

/** Where the pointer is over `stage`, normalized to the picture and kept on it. */
function pointOn(stage: HTMLElement, event: ReactPointerEvent): Point {
  const box = stage.getBoundingClientRect();
  return {
    x: clamp((event.clientX - box.left) / box.width, 0, 1),
    y: clamp((event.clientY - box.top) / box.height, 0, 1),
  };
}

/**
 * A zoom's frame over the whole picture, for one pose: the part the camera
 * shows on its card (the whole picture when it pulls back), and when the
 * pose turns the picture, the card's turned outline. Pressing anywhere puts
 * the target there, dragging moves it, and letting go commits it; dragging
 * the turn handle turns the picture (across) and tilts it (up and down).
 */
function ZoomFrame({
  pose,
  lens,
  onCommit,
  onTurn,
}: {
  readonly pose: ZoomPoseDto;
  readonly lens: number | undefined;
  readonly onCommit: (anchor: Point) => void;
  readonly onTurn: (rotation: CameraRotation) => void;
}) {
  const aspect = use(PictureAspect);
  const [draft, setDraft] = useState<Draft<Point> | null>(null);
  const [turnDraft, setTurnDraft] = useState<
    (Draft<CameraRotation> & { readonly origin: Point }) | null
  >(null);
  const current = pose.anchor;
  const anchor = draft !== null && samePoint(draft.base, current) ? draft.value : current;
  const currentTurn = pose.rotation ?? FLAT;
  const turn =
    turnDraft !== null && sameTurn(turnDraft.base, currentTurn) ? turnDraft.value : currentTurn;
  const view = { scale: pose.scale, centerX: anchor.x, centerY: anchor.y };
  const turned = !sameTurn(turn, FLAT);
  const { crop, toOutput: card } = cardTransform(
    { ...clampView(view), rotation: turn, ...(lens === undefined ? {} : { lens }) },
    aspect,
  );
  const [left, top] = [crop.centerX - 0.5 / crop.scale, crop.centerY - 0.5 / crop.scale];
  const [right, bottom] = [crop.centerX + 0.5 / crop.scale, crop.centerY + 0.5 / crop.scale];
  const outline = `${left},${top} ${right},${top} ${right},${bottom} ${left},${bottom}`;
  // The frame as the turn leans it, drawn over the frame itself.
  const cardOutline = CARD_CORNERS.map(([x, y]) => applyHomography(card, x, y))
    .map((corner) => `${left + corner.x * (right - left)},${top + corner.y * (bottom - top)}`)
    .join(' ');
  return (
    <div
      className="overlay overlay-zoom"
      data-testid="zoom-overlay"
      onPointerDown={(event) => {
        if (event.button === 0) {
          event.currentTarget.setPointerCapture(event.pointerId);
          setDraft({ base: current, value: pointOn(event.currentTarget, event), active: true });
        }
      }}
      onPointerMove={(event) => {
        if (draft?.active === true) {
          setDraft({ ...draft, value: pointOn(event.currentTarget, event) });
        }
      }}
      onPointerUp={() => {
        if (draft?.active === true) {
          onCommit(draft.value);
          setDraft({ ...draft, active: false });
        }
      }}
      onPointerCancel={() => setDraft(null)}
    >
      <svg
        className="zoom-frame"
        data-testid="zoom-frame"
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path className="zoom-shade" fillRule="evenodd" d={`M0,0 1,0 1,1 0,1Z M${outline}Z`} />
        <polygon className="zoom-outline" points={outline} />
        {turned && <polygon className="zoom-turn" points={cardOutline} />}
      </svg>
      <div className="zoom-target" style={{ left: percent(anchor.x), top: percent(anchor.y) }} />
      <div
        className={turnDraft?.active === true ? 'turn-handle turning' : 'turn-handle'}
        data-testid="turn-handle"
        role="slider"
        aria-label="Turn the picture"
        aria-valuemin={-MAX_CAMERA_TURN_DEGREES}
        aria-valuemax={MAX_CAMERA_TURN_DEGREES}
        aria-valuenow={turn.y}
        aria-valuetext={`${turn.x}° tilt, ${turn.y}° turn`}
        title="Drag to turn the picture in 3D"
        style={{ left: percent(anchor.x), top: percent(Math.min(0.92, anchor.y + 0.12)) }}
        onPointerDown={(event) => {
          if (event.button !== 0) {
            return;
          }
          event.stopPropagation();
          const stage = event.currentTarget.parentElement;
          if (stage === null) {
            return;
          }
          event.currentTarget.setPointerCapture(event.pointerId);
          setTurnDraft({
            base: currentTurn,
            value: currentTurn,
            origin: pointOn(stage, event),
            active: true,
          });
        }}
        onPointerMove={(event) => {
          const stage = event.currentTarget.parentElement;
          if (turnDraft?.active === true && stage !== null) {
            const point = pointOn(stage, event);
            setTurnDraft({
              ...turnDraft,
              value: draggedTurn(turnDraft.base, turnDraft.origin, point),
            });
          }
        }}
        onPointerUp={(event) => {
          event.stopPropagation();
          if (turnDraft?.active === true) {
            onTurn(turnDraft.value);
            setTurnDraft({ ...turnDraft, active: false });
          }
        }}
        onPointerCancel={() => setTurnDraft(null)}
      >
        {turnDraft?.active === true && (
          <span className="turn-readout">
            {turn.x}° tilt, {turn.y}° turn
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Edits the selected zoom's target at the playhead: a still zoom changes as
 * a whole, a moving one gets a keyframe there (editZoomPose).
 */
export function ZoomFrameEditor({
  zoom,
  clip,
  playback,
  toleranceUs,
  onChange,
}: {
  readonly zoom: ZoomDto;
  readonly clip: SnapshotClip;
  readonly playback: PlaybackStore;
  readonly toleranceUs: number;
  readonly onChange: (effect: EffectDto) => void;
}) {
  const playheadUs = useStore(playback, (state) => state.playheadUs);
  const sourceUs = Math.round(sourceTimeUs(clip, playheadUs));
  return (
    <ZoomFrame
      pose={zoomPoseAt(zoom, sourceUs, toleranceUs)}
      lens={zoom.lens}
      onCommit={(anchor) => onChange(editZoomPose(zoom, sourceUs, { anchor }, toleranceUs))}
      onTurn={(rotation) => onChange(editZoomRotation(zoom, sourceUs, rotation, toleranceUs))}
    />
  );
}

type MaskHandle = 'move' | 'nw' | 'ne' | 'sw' | 'se';

interface MaskDrag {
  readonly handle: MaskHandle;
  readonly origin: Point;
  readonly start: Rectangle;
}

/** The box a drag of `handle` from `origin` to `point` makes of `start`. */
function draggedBox(drag: MaskDrag, point: Point): Rectangle {
  const { start, origin, handle } = drag;
  if (handle === 'move') {
    return {
      ...start,
      x: clamp(start.x + point.x - origin.x, 0, 1 - start.width),
      y: clamp(start.y + point.y - origin.y, 0, 1 - start.height),
    };
  }
  // The opposite corner stays put; the dragged one follows the pointer.
  const fixedX = handle === 'nw' || handle === 'sw' ? start.x + start.width : start.x;
  const fixedY = handle === 'nw' || handle === 'ne' ? start.y + start.height : start.y;
  const left = Math.min(fixedX, point.x);
  const top = Math.min(fixedY, point.y);
  return {
    x: left,
    y: top,
    width: Math.max(MIN_MASK, Math.abs(point.x - fixedX)),
    height: Math.max(MIN_MASK, Math.abs(point.y - fixedY)),
  };
}

/**
 * A box over the picture: drag it to move it, drag a corner to resize it.
 * `name` prefixes its test IDs (the blur's by default).
 */
function BlurBox({
  bounds,
  round,
  onCommit,
  name = 'blur',
}: {
  readonly bounds: Rectangle;
  readonly round: boolean;
  readonly onCommit: (bounds: Rectangle) => void;
  readonly name?: string;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<MaskDrag | null>(null);
  const [draft, setDraft] = useState<Draft<Rectangle> | null>(null);
  const shown = draft !== null && sameBox(draft.base, bounds) ? draft.value : bounds;

  const begin = (event: ReactPointerEvent<HTMLElement>, handle: MaskHandle) => {
    const stage = stageRef.current;
    if (event.button !== 0 || stage === null) {
      return;
    }
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ handle, origin: pointOn(stage, event), start: shown });
    setDraft({ base: bounds, value: shown, active: true });
  };
  const handles: readonly MaskHandle[] = ['nw', 'ne', 'sw', 'se'];

  return (
    <div
      ref={stageRef}
      className="overlay overlay-blur"
      data-testid={`${name}-overlay`}
      onPointerMove={(event) => {
        if (drag !== null && draft !== null && stageRef.current !== null) {
          setDraft({ ...draft, value: draggedBox(drag, pointOn(stageRef.current, event)) });
        }
      }}
      onPointerUp={() => {
        if (drag !== null && draft !== null) {
          if (!sameBox(draft.value, drag.start)) {
            onCommit(draft.value);
          }
          setDraft({ ...draft, active: false });
        }
        setDrag(null);
      }}
      onPointerCancel={() => {
        setDrag(null);
        setDraft(null);
      }}
    >
      <div
        className={`blur-box${round ? ' round' : ''}`}
        data-testid={`${name}-box`}
        style={{
          left: percent(shown.x),
          top: percent(shown.y),
          width: percent(shown.width),
          height: percent(shown.height),
        }}
        onPointerDown={(event) => begin(event, 'move')}
      >
        {handles.map((handle) => (
          <span
            key={handle}
            className={`blur-handle handle-${handle}`}
            data-testid={`${name}-handle-${handle}`}
            onPointerDown={(event) => begin(event, handle)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Edits the selected blur's mask at the playhead: a still blur changes as a
 * whole, a moving one gets a keyframe there (editBlurMask).
 */
export function BlurMaskEditor({
  blur,
  clip,
  playback,
  toleranceUs,
  onChange,
}: {
  readonly blur: BlurDto;
  readonly clip: SnapshotClip;
  readonly playback: PlaybackStore;
  readonly toleranceUs: number;
  readonly onChange: (effect: EffectDto) => void;
}) {
  const playheadUs = useStore(playback, (state) => state.playheadUs);
  const sourceUs = Math.round(sourceTimeUs(clip, playheadUs));
  const mask = blurMaskAt(blur, sourceUs);
  const [region] = mask;
  if (region === undefined || region.kind === 'polygon') {
    return null; // a polygon is drawn, but not edited here yet
  }
  return (
    <BlurBox
      bounds={region.bounds}
      round={region.kind === 'ellipse'}
      onCommit={(bounds) =>
        onChange(
          editBlurMask(
            blur,
            sourceUs,
            [{ kind: region.kind, bounds }, ...mask.slice(1)],
            toleranceUs,
          ),
        )
      }
    />
  );
}

/** A drag of one of the points (`index`), or of them all together (-1), from `origin`. */
interface PointsDrag {
  readonly index: number;
  readonly origin: Point;
  readonly start: readonly Point[];
}

const samePoints = (first: readonly Point[], second: readonly Point[]) =>
  first.length === second.length &&
  first.every((point, at) => samePoint(point, second[at] ?? point));

/**
 * Points over the picture, each dragged on its own, and with `moveAll` a grip
 * between them that moves them together, kept on the picture. With two, a
 * line joins them. Letting go commits the points.
 */
function PointHandles({
  points,
  names,
  moveAll,
  onCommit,
}: {
  readonly points: readonly Point[];
  /** Each point's name, for its handle's title and test ID. */
  readonly names: readonly string[];
  readonly moveAll: boolean;
  readonly onCommit: (points: readonly Point[]) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<PointsDrag | null>(null);
  const [draft, setDraft] = useState<Draft<readonly Point[]> | null>(null);
  const shown = draft !== null && samePoints(draft.base, points) ? draft.value : points;

  const begin = (event: ReactPointerEvent<HTMLElement>, index: number) => {
    const stage = stageRef.current;
    if (event.button !== 0 || stage === null) {
      return;
    }
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ index, origin: pointOn(stage, event), start: shown });
    setDraft({ base: points, value: shown, active: true });
  };
  const dragged = (current: PointsDrag, point: Point): readonly Point[] => {
    if (current.index >= 0) {
      return current.start.map((start, at) => (at === current.index ? point : start));
    }
    // Together: as far as the pointer moved, but no point leaves the picture.
    const xs = current.start.map((start) => start.x);
    const ys = current.start.map((start) => start.y);
    const dx = clamp(point.x - current.origin.x, -Math.min(...xs), 1 - Math.max(...xs));
    const dy = clamp(point.y - current.origin.y, -Math.min(...ys), 1 - Math.max(...ys));
    return current.start.map((start) => ({ x: start.x + dx, y: start.y + dy }));
  };
  const middle = {
    x: shown.reduce((sum, point) => sum + point.x, 0) / Math.max(1, shown.length),
    y: shown.reduce((sum, point) => sum + point.y, 0) / Math.max(1, shown.length),
  };
  const [first, second] = shown;

  return (
    <div
      ref={stageRef}
      className="overlay overlay-blur"
      data-testid="annotation-overlay"
      onPointerMove={(event) => {
        if (drag !== null && draft !== null && stageRef.current !== null) {
          setDraft({ ...draft, value: dragged(drag, pointOn(stageRef.current, event)) });
        }
      }}
      onPointerUp={() => {
        if (drag !== null && draft !== null) {
          if (!samePoints(draft.value, drag.start)) {
            onCommit(draft.value);
          }
          setDraft({ ...draft, active: false });
        }
        setDrag(null);
      }}
      onPointerCancel={() => {
        setDrag(null);
        setDraft(null);
      }}
    >
      {first !== undefined && second !== undefined && (
        <svg className="annotation-line" viewBox="0 0 100 100" preserveAspectRatio="none">
          <line
            x1={first.x * 100}
            y1={first.y * 100}
            x2={second.x * 100}
            y2={second.y * 100}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
      {moveAll && (
        <span
          className="annotation-handle annotation-move"
          data-testid="annotation-handle-move"
          title="Move"
          style={{ left: percent(middle.x), top: percent(middle.y) }}
          onPointerDown={(event) => begin(event, -1)}
        />
      )}
      {shown.map((point, index) => (
        <span
          key={names[index] ?? index}
          className="annotation-handle"
          data-testid={`annotation-handle-${names[index] ?? index}`}
          title={names[index]}
          style={{ left: percent(point.x), top: percent(point.y) }}
          onPointerDown={(event) => begin(event, index)}
        />
      ))}
    </div>
  );
}

/**
 * A frame round the words, the size of the label the picture draws for them
 * (the same type, sized in the overlay's own height), dragged from anywhere
 * inside to move them. Letting go commits where their middle is.
 */
function WordsFrame({
  shape,
  onCommit,
}: {
  readonly shape: Extract<AnnotationShapeDto, { kind: 'text' }>;
  readonly onCommit: (at: Point) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ readonly origin: Point; readonly start: Point } | null>(null);
  const [draft, setDraft] = useState<Draft<Point> | null>(null);
  const shown = draft !== null && samePoint(draft.base, shape.at) ? draft.value : shape.at;
  return (
    <div
      ref={stageRef}
      className="overlay overlay-blur overlay-words"
      data-testid="annotation-overlay"
      onPointerMove={(event) => {
        if (drag !== null && draft !== null && stageRef.current !== null) {
          const point = pointOn(stageRef.current, event);
          setDraft({
            ...draft,
            value: {
              x: clamp(drag.start.x + point.x - drag.origin.x, 0, 1),
              y: clamp(drag.start.y + point.y - drag.origin.y, 0, 1),
            },
          });
        }
      }}
      onPointerUp={() => {
        if (drag !== null && draft !== null) {
          if (!samePoint(draft.value, drag.start)) {
            onCommit(draft.value);
          }
          setDraft({ ...draft, active: false });
        }
        setDrag(null);
      }}
      onPointerCancel={() => {
        setDrag(null);
        setDraft(null);
      }}
    >
      <span
        className="words-frame"
        data-testid="annotation-handle-words"
        title="Drag to move the words"
        style={{
          left: percent(shown.x),
          top: percent(shown.y),
          fontSize: `${shape.size * 100}cqh`,
        }}
        onPointerDown={(event) => {
          const stage = stageRef.current;
          if (event.button !== 0 || stage === null) {
            return;
          }
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          setDrag({ origin: pointOn(stage, event), start: shown });
          setDraft({ base: shape.at, value: shown, active: true });
        }}
      >
        {shape.text}
      </span>
    </div>
  );
}

/**
 * Moves the selected annotation over the picture (ADR-011): its words by a
 * frame round them, an arrow by either end or its middle, a box as a blur's is.
 */
export function AnnotationEditor({
  annotation,
  onChange,
}: {
  readonly annotation: AnnotationDto;
  readonly onChange: (effect: EffectDto) => void;
}) {
  const shape = annotation.shape;
  const set = (next: AnnotationShapeDto) => onChange({ ...annotation, shape: next });
  switch (shape.kind) {
    case 'text':
      return <WordsFrame shape={shape} onCommit={(at) => set({ ...shape, at })} />;
    case 'arrow':
      return (
        <PointHandles
          points={[shape.from, shape.to]}
          names={['tail', 'point']}
          moveAll
          onCommit={([from, to]) => {
            // An arrow needs a length: ends dropped on each other leave it as it was.
            if (
              from !== undefined &&
              to !== undefined &&
              Math.hypot(to.x - from.x, to.y - from.y) > 0.01
            ) {
              set({ ...shape, from, to });
            }
          }}
        />
      );
    case 'box':
      return (
        <BlurBox
          bounds={shape.bounds}
          round={false}
          name="annotation"
          onCommit={(bounds) => set({ ...shape, bounds })}
        />
      );
  }
}
