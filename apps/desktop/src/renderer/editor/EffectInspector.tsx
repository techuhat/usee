import type { ReactNode } from 'react';
import { useStore } from 'zustand';

import type { EffectDto } from '@usee/contracts';
import {
  MAX_ANNOTATION_LINE,
  MAX_ANNOTATION_TEXT,
  MAX_ANNOTATION_TEXT_SIZE,
  MAX_BLUR_INTENSITY,
  MAX_CAMERA_TURN_DEGREES,
  MAX_ZOOM_SCALE,
  MIN_ANNOTATION_LINE,
  MIN_ANNOTATION_TEXT_SIZE,
  presetKeyframes,
} from '@usee/domain';

import { CameraMoveButtons } from './camera-moves';
import { CommitSlider, TextField } from './controls';
import {
  addBlurKeyframe,
  addZoomKeyframe,
  editZoomPose,
  editZoomTurn,
  effectEndUs,
  effectKeyframes,
  holdZoomKeyframe,
  keyframeIndexAt,
  removeBlurKeyframe,
  removeZoomKeyframe,
  reshapeBlur,
  reshapedAnnotation,
  zoomPoseAt,
  zoomScale,
  type AnnotationDto,
  type AnnotationShapeDto,
  type BlurDto,
  type ZoomDto,
} from './effect-editing';
import type { PlaybackStore } from './playback-store';
import { formatTimecode } from './timecode';
import { sourceTimeUs, type SnapshotClip } from './timeline-math';
import { Section, Segmented, Swatches, Switch, type Choice, type Swatch } from './ui';

const ANNOTATION_SHAPES: readonly Choice<AnnotationShapeDto['kind']>[] = [
  { value: 'text', label: 'Text', title: 'Words, on a label or bare' },
  { value: 'arrow', label: 'Arrow', title: 'An arrow pointing at something' },
  { value: 'box', label: 'Box', title: 'A box around something' },
];

/** Colours that read on most recordings: light, dark, and the accents people mark with. */
const ANNOTATION_COLOURS: readonly Swatch[] = [
  { id: '#ffffff', name: 'White', paint: '#ffffff' },
  { id: '#111420', name: 'Ink', paint: '#111420' },
  { id: '#ffb23e', name: 'Amber', paint: '#ffb23e' },
  { id: '#ff3b30', name: 'Red', paint: '#ff3b30' },
  { id: '#34c759', name: 'Green', paint: '#34c759' },
  { id: '#0a84ff', name: 'Blue', paint: '#0a84ff' },
];

const ANNOTATION_HINTS: Readonly<Record<AnnotationShapeDto['kind'], string>> = {
  text: 'Drag the words over the picture to move them.',
  arrow: 'Drag either end of the arrow over the picture, or its middle to move it.',
  box: 'Drag the box to move it, or a corner to resize it.',
};

/** A pose's turn about each axis (CameraRotation), as the inspector names it. */
const TURNS = [
  { axis: 'x', label: 'Tilt' },
  { axis: 'y', label: 'Turn' },
  { axis: 'z', label: 'Rotate' },
] as const;

const MOTIONS: readonly Choice<ZoomDto['easing']>[] = [
  { value: 'ease-in-out', label: 'Smooth' },
  { value: 'linear', label: 'Even' },
  { value: 'ease-in', label: 'Slow start' },
  { value: 'ease-out', label: 'Slow finish' },
];

/** Lenses by how deep a turn looks: a narrow field of view flattens it, a wide one deepens it. */
const LENSES = [
  { value: 'gentle', label: 'Gentle', degrees: 20 },
  { value: 'normal', label: 'Normal', degrees: 30 },
  { value: 'strong', label: 'Strong', degrees: 50 },
] as const;
type Lens = (typeof LENSES)[number]['value'];

/** The lens choice nearest a zoom's lens; normal when it has none. */
function lensOf(zoom: ZoomDto): Lens {
  const degrees = zoom.lens ?? 30;
  return LENSES.reduce((best, lens) =>
    Math.abs(lens.degrees - degrees) < Math.abs(best.degrees - degrees) ? lens : best,
  ).value;
}

/** The zoom with a lens chosen; the normal lens is no lens at all. */
function withLens(zoom: ZoomDto, lens: Lens): ZoomDto {
  const { lens: _old, ...rest } = zoom;
  const degrees = LENSES.find((choice) => choice.value === lens)?.degrees ?? 30;
  return degrees === 30 ? rest : { ...rest, lens: degrees };
}

type BlurShape = 'rectangle' | 'ellipse' | 'polygon';

const BLUR_SHAPES: readonly Choice<BlurShape>[] = [
  { value: 'rectangle', label: 'Rectangle' },
  { value: 'ellipse', label: 'Ellipse' },
];

interface ControlsProps<Effect> {
  readonly effect: Effect;
  /** The playhead in the clip's source time. */
  readonly sourceUs: number;
  readonly toleranceUs: number;
  readonly onChange: (effect: EffectDto) => void;
}

/** What an annotation is and how it looks: its shape, words, colour and size (ADR-011). */
function AnnotationControls({ effect: note, onChange }: ControlsProps<AnnotationDto>) {
  const shape = note.shape;
  const set = (next: AnnotationShapeDto) => onChange({ ...note, shape: next });
  const colour = ANNOTATION_COLOURS.find(
    (swatch) => swatch.id.toLowerCase() === shape.color.toLowerCase(),
  );
  return (
    <>
      <div className="field">
        <span className="field-label">Shape</span>
        <Segmented
          label="Annotation shape"
          value={shape.kind}
          choices={ANNOTATION_SHAPES}
          onChange={(kind) => set(reshapedAnnotation(shape, kind))}
        />
      </div>
      {shape.kind === 'text' && (
        <>
          <TextField
            label="Words"
            value={shape.text}
            maxLength={MAX_ANNOTATION_TEXT}
            onCommit={(text) => set({ ...shape, text })}
          />
          <Switch
            label="On a label"
            checked={shape.background}
            onChange={(background) => set({ ...shape, background })}
          />
        </>
      )}
      <div className="field">
        <span className="field-label">Colour</span>
        <Swatches
          label="Annotation colour"
          swatches={ANNOTATION_COLOURS}
          selected={colour?.id}
          onPick={(swatch) => set({ ...shape, color: swatch.id })}
        />
      </div>
      {shape.kind === 'text' ? (
        <CommitSlider
          label="Size"
          value={shape.size}
          min={MIN_ANNOTATION_TEXT_SIZE}
          max={MAX_ANNOTATION_TEXT_SIZE}
          step={0.005}
          format={(value) => `${Math.round(value * 100)}%`}
          onCommit={(size) => set({ ...shape, size })}
        />
      ) : (
        <CommitSlider
          label="Thickness"
          value={shape.lineWidth}
          min={MIN_ANNOTATION_LINE}
          max={MAX_ANNOTATION_LINE}
          step={0.001}
          format={(value) => `${(value * 100).toFixed(1)}%`}
          onCommit={(lineWidth) => set({ ...shape, lineWidth })}
        />
      )}
      <p className="field-note">{ANNOTATION_HINTS[shape.kind]}</p>
    </>
  );
}

/** An effect's keyframes at the playhead: how many, and adding or removing the one there. */
function KeyframeControls({
  effect,
  sourceUs,
  toleranceUs,
  onAdd,
  onRemove,
  note,
  atKeyframe,
}: {
  readonly effect: EffectDto;
  readonly sourceUs: number;
  readonly toleranceUs: number;
  readonly onAdd: () => void;
  readonly onRemove: (index: number) => void;
  readonly note: string;
  /** What to show while the playhead is on keyframe `index` of several. */
  readonly atKeyframe?: (index: number, count: number) => ReactNode;
}) {
  const keyframes = effectKeyframes(effect);
  const inside = sourceUs >= effect.range.startUs && sourceUs <= effectEndUs(effect);
  const here = keyframeIndexAt(keyframes, sourceUs, toleranceUs);
  return (
    <Section
      title="Keyframes"
      aside={
        <span className="section-note" data-testid="effect-keyframes">
          {keyframes.length === 1 ? 'Still' : `${keyframes.length} keyframes`}
        </span>
      }
    >
      <div className="button-pair">
        <button type="button" disabled={!inside || here !== -1} onClick={onAdd}>
          Add keyframe
        </button>
        <button
          type="button"
          disabled={here === -1 || keyframes.length <= 1}
          onClick={() => onRemove(here)}
        >
          Remove keyframe
        </button>
      </div>
      {here !== -1 && keyframes.length > 1 && atKeyframe?.(here, keyframes.length)}
      <p className="field-note">{note}</p>
    </Section>
  );
}

function ZoomControls({ effect: zoom, sourceUs, toleranceUs, onChange }: ControlsProps<ZoomDto>) {
  const pose = zoomPoseAt(zoom, sourceUs, toleranceUs);
  return (
    <>
      <CommitSlider
        label="Scale"
        value={pose.scale}
        min={1.1}
        max={MAX_ZOOM_SCALE}
        step={0.1}
        format={(value) => `${value.toFixed(1)}×`}
        onCommit={(scale) =>
          onChange(editZoomPose(zoom, sourceUs, { scale: zoomScale(scale) }, toleranceUs))
        }
      />
      <p className="field-note">Drag the frame over the picture to choose what to zoom into.</p>
    </>
  );
}

/** The zoom's sections after its first: how the camera moves, its 3D turn and its keyframes. */
function ZoomSections({ effect: zoom, sourceUs, toleranceUs, onChange }: ControlsProps<ZoomDto>) {
  const rotation = zoomPoseAt(zoom, sourceUs, toleranceUs).rotation ?? { x: 0, y: 0, z: 0 };
  return (
    <>
      <Section title="3D moves">
        <CameraMoveButtons
          onApply={(preset) => onChange({ ...zoom, poses: presetKeyframes(zoom, preset) })}
        />
        <p className="field-note">
          Each writes the zoom’s keyframes in one step; change any of them after.
        </p>
      </Section>
      <Section title="Motion">
        <CommitSlider
          label="Transition"
          value={zoom.easeInUs / 1_000_000}
          min={0}
          max={1.5}
          step={0.05}
          format={(value) => `${value.toFixed(2)} s`}
          onCommit={(seconds) => {
            const ramp = Math.min(
              Math.round(seconds * 1_000_000),
              Math.floor(zoom.range.durationUs / 2),
            );
            onChange({ ...zoom, easeInUs: ramp, easeOutUs: ramp });
          }}
        />
        <Segmented
          label="Motion"
          value={zoom.easing}
          choices={MOTIONS}
          columns={2}
          onChange={(easing) => onChange({ ...zoom, easing })}
        />
      </Section>
      <Section title="3D">
        {TURNS.map(({ axis, label }) => (
          <CommitSlider
            key={axis}
            label={label}
            value={rotation[axis]}
            min={-MAX_CAMERA_TURN_DEGREES}
            max={MAX_CAMERA_TURN_DEGREES}
            step={1}
            format={(value) => `${Math.round(value)}°`}
            onCommit={(degrees) =>
              onChange(editZoomTurn(zoom, sourceUs, axis, Math.round(degrees), toleranceUs))
            }
          />
        ))}
        <Segmented
          label="Perspective"
          value={lensOf(zoom)}
          choices={LENSES}
          onChange={(lens) => onChange(withLens(zoom, lens))}
        />
        <p className="field-note">
          Tilt, turn and rotate show the picture in 3D; perspective says how deep a turn looks.
        </p>
      </Section>
      <KeyframeControls
        effect={zoom}
        sourceUs={sourceUs}
        toleranceUs={toleranceUs}
        onAdd={() => onChange(addZoomKeyframe(zoom, sourceUs))}
        onRemove={(index) => onChange(removeZoomKeyframe(zoom, index))}
        note="The camera flows through keyframes on one smooth path, and stops only where it holds."
        atKeyframe={(index, count) => {
          const fixed = index === 0 || index === count - 1;
          return (
            <Switch
              label="Hold here"
              checked={fixed || zoom.poses[index]?.hold === true}
              disabled={fixed}
              onChange={(hold) => onChange(holdZoomKeyframe(zoom, index, hold))}
            />
          );
        }}
      />
    </>
  );
}

function BlurControls({ effect: blur, onChange }: ControlsProps<BlurDto>) {
  return (
    <>
      <CommitSlider
        label="Strength"
        value={blur.intensity}
        min={0.005}
        max={MAX_BLUR_INTENSITY}
        step={0.005}
        format={(value) => `${(value * 100).toFixed(1)}%`}
        onCommit={(intensity) => onChange({ ...blur, intensity })}
      />
      <p className="field-note">Drag the box over the picture to move or resize the blur.</p>
    </>
  );
}

/** The blur's sections after its first: its shape and its keyframes. */
function BlurSections({ effect: blur, sourceUs, toleranceUs, onChange }: ControlsProps<BlurDto>) {
  const shape = blur.regions[0]?.value[0]?.kind ?? 'rectangle';
  return (
    <>
      <Section title="Shape">
        <Segmented
          label="Shape"
          value={shape}
          choices={
            shape === 'polygon'
              ? [...BLUR_SHAPES, { value: 'polygon', label: 'Polygon' }]
              : BLUR_SHAPES
          }
          disabled={shape === 'polygon'}
          onChange={(picked) =>
            onChange(reshapeBlur(blur, picked === 'ellipse' ? 'ellipse' : 'rectangle'))
          }
        />
      </Section>
      <KeyframeControls
        effect={blur}
        sourceUs={sourceUs}
        toleranceUs={toleranceUs}
        onAdd={() => onChange(addBlurKeyframe(blur, sourceUs))}
        onRemove={(index) => onChange(removeBlurKeyframe(blur, index))}
        note="With keyframes, the blur moves from one to the next."
      />
    </>
  );
}

/** The selected effect's settings; every change is one edit command. */
export function EffectInspector({
  effect,
  clip,
  playback,
  toleranceUs,
  onChange,
  onRemove,
}: {
  readonly effect: EffectDto;
  readonly clip: SnapshotClip;
  readonly playback: PlaybackStore;
  /** How near the playhead a keyframe counts as at it. */
  readonly toleranceUs: number;
  readonly onChange: (effect: EffectDto) => void;
  readonly onRemove: () => void;
}) {
  const playheadUs = useStore(playback, (state) => state.playheadUs);
  const sourceUs = Math.round(sourceTimeUs(clip, playheadUs));
  const name =
    effect.kind === 'zoom'
      ? 'Zoom'
      : effect.kind === 'blur'
        ? 'Blur'
        : effect.kind === 'annotation'
          ? 'Annotation'
          : 'Effect';
  const startUs = Math.max(0, clip.timelineStartUs + (effect.range.startUs - clip.sourceStartUs));
  const controls = { sourceUs, toleranceUs, onChange };
  return (
    <div className="inspector-body" data-testid="effect-inspector">
      <Section
        title={name}
        aside={
          <span className="section-note">
            {formatTimecode(startUs)} – {formatTimecode(startUs + effect.range.durationUs)}
          </span>
        }
      >
        <Switch
          label={`Use this ${name.toLowerCase()}`}
          checked={effect.enabled}
          onChange={(enabled) => onChange({ ...effect, enabled })}
        />
        {effect.kind === 'zoom' && <ZoomControls effect={effect} {...controls} />}
        {effect.kind === 'blur' && <BlurControls effect={effect} {...controls} />}
        {effect.kind === 'annotation' && <AnnotationControls effect={effect} {...controls} />}
      </Section>
      {effect.kind === 'zoom' && <ZoomSections effect={effect} {...controls} />}
      {effect.kind === 'blur' && <BlurSections effect={effect} {...controls} />}
      <div className="inspector-footer">
        <button type="button" className="danger" onClick={onRemove}>
          Delete {name.toLowerCase()}
        </button>
      </div>
    </div>
  );
}
