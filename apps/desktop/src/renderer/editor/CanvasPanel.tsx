import type { CanvasStyleDto } from '@usee/contracts';

import { ColorField, CommitSlider } from './controls';
import { Section, Segmented, Swatches, type Choice, type Swatch } from './ui';

type Aspect = CanvasStyleDto['aspect'];
type Background = CanvasStyleDto['background'];
type Gradient = Extract<Background, { kind: 'gradient' }>;
type BlurredSource = Extract<Background, { kind: 'blurred-source' }>;

/** A rectangle of the output's shape, so each choice shows what it makes. */
function ShapeGlyph({ width, height }: { readonly width: number; readonly height: number }) {
  return (
    <svg className="shape-glyph" viewBox="0 0 24 24" aria-hidden="true">
      <rect x={12 - width / 2} y={12 - height / 2} width={width} height={height} rx="1.5" />
    </svg>
  );
}

const SHAPES: readonly Choice<Aspect>[] = [
  {
    value: 'source',
    label: 'Auto',
    title: 'As recorded',
    icon: <ShapeGlyph width={18} height={13} />,
  },
  { value: '16:9', label: '16:9', title: 'Landscape', icon: <ShapeGlyph width={20} height={11} /> },
  { value: '9:16', label: '9:16', title: 'Vertical', icon: <ShapeGlyph width={11} height={20} /> },
  { value: '1:1', label: '1:1', title: 'Square', icon: <ShapeGlyph width={16} height={16} /> },
  { value: '4:5', label: '4:5', title: 'Portrait', icon: <ShapeGlyph width={14} height={17.5} /> },
];

/** Backgrounds to start from: gradients first, then plain colours. */
export const BACKGROUNDS: readonly (Swatch & { readonly background: Background })[] = [
  blurredSource('soft', 'Soft blur', 0.04),
  gradient('dusk', 'Dusk', '#1b2550', '#6d3bd1'),
  gradient('aurora', 'Aurora', '#0f3443', '#34e89e'),
  gradient('ember', 'Ember', '#42275a', '#f39f86'),
  gradient('ocean', 'Ocean', '#0f2027', '#2c5364'),
  gradient('peach', 'Peach', '#ffb88c', '#de6262'),
  gradient('mint', 'Mint', '#43cea2', '#185a9d'),
  gradient('sunrise', 'Sunrise', '#f7971e', '#ffd200'),
  gradient('graphite', 'Graphite', '#232526', '#414345'),
  solid('ink', 'Ink', '#0b1020'),
  solid('charcoal', 'Charcoal', '#1f2128'),
  solid('snow', 'Snow', '#f4f5f9'),
  solid('sky', 'Sky', '#4b7bec'),
];

function gradient(id: string, name: string, from: string, to: string) {
  const background: Gradient = { kind: 'gradient', from, to, angle: 135 };
  return { id, name, paint: `linear-gradient(135deg, ${from}, ${to})`, background };
}

function solid(id: string, name: string, color: string) {
  const background: Background = { kind: 'solid', color };
  return { id, name, paint: color, background };
}

function blurredSource(id: string, name: string, blur: number) {
  const background: BlurredSource = { kind: 'blurred-source', blur };
  return {
    id,
    name,
    paint: 'radial-gradient(circle at 30% 25%, #7984b8, #303a67 42%, #151a31)',
    background,
  };
}

const sameBackground = (a: Background, b: Background) => JSON.stringify(a) === JSON.stringify(b);

const percent = (value: number) => `${Math.round(value * 100)}%`;

/** The output canvas: its shape, background, padding, corners, shadow and motion blur. */
export function CanvasPanel({
  style,
  onChange,
}: {
  readonly style: CanvasStyleDto;
  readonly onChange: (style: CanvasStyleDto) => void;
}) {
  const setBackground = (background: Background) => onChange({ ...style, background });
  const { background } = style;
  const preset = BACKGROUNDS.find((swatch) => sameBackground(swatch.background, background));
  return (
    <div className="inspector-body" data-testid="canvas-panel">
      <Section title="Shape">
        <Segmented
          label="Shape"
          value={style.aspect}
          choices={SHAPES}
          onChange={(aspect) => onChange({ ...style, aspect })}
        />
      </Section>

      <Section
        title="Background"
        aside={<span className="section-note">{preset?.name ?? 'Custom'}</span>}
      >
        <Swatches
          label="Background"
          swatches={BACKGROUNDS}
          selected={preset?.id}
          onPick={(swatch) => {
            const picked = BACKGROUNDS.find((candidate) => candidate.id === swatch.id);
            if (picked !== undefined) {
              setBackground(picked.background);
            }
          }}
        />
        {background.kind === 'solid' && (
          <ColorField
            label="Colour"
            value={background.color}
            onCommit={(color) => setBackground({ kind: 'solid', color })}
          />
        )}
        {background.kind === 'gradient' && (
          <>
            <div className="field-pair">
              <ColorField
                label="From"
                value={background.from}
                onCommit={(from) => setBackground({ ...background, from })}
              />
              <ColorField
                label="To"
                value={background.to}
                onCommit={(to) => setBackground({ ...background, to })}
              />
            </div>
            <CommitSlider
              label="Angle"
              value={background.angle}
              min={0}
              max={360}
              step={15}
              format={(value) => `${Math.round(value)}°`}
              onCommit={(angle) => setBackground({ ...background, angle })}
            />
          </>
        )}
        {background.kind === 'blurred-source' && (
          <>
            <CommitSlider
              label="Backdrop blur"
              value={background.blur}
              min={0.01}
              max={0.15}
              step={0.01}
              format={(value) => `${Math.round(value * 100)}%`}
              onCommit={(blur) => setBackground({ kind: 'blurred-source', blur })}
            />
            <p className="field-note">Uses the recorded picture behind the framed video.</p>
          </>
        )}
      </Section>

      <Section title="Frame">
        <CommitSlider
          label="Padding"
          value={style.padding}
          min={0}
          max={0.4}
          step={0.01}
          format={percent}
          onCommit={(padding) => onChange({ ...style, padding })}
        />
        <CommitSlider
          label="Corners"
          value={style.cornerRadius}
          min={0}
          max={0.5}
          step={0.01}
          format={percent}
          onCommit={(cornerRadius) => onChange({ ...style, cornerRadius })}
        />
        <CommitSlider
          label="Shadow"
          value={style.shadow.opacity}
          min={0}
          max={1}
          step={0.05}
          format={percent}
          onCommit={(opacity) => onChange({ ...style, shadow: { ...style.shadow, opacity } })}
        />
      </Section>

      <Section title="Motion">
        <CommitSlider
          label="Motion blur"
          value={style.motionBlur ?? 0}
          min={0}
          max={1}
          step={0.05}
          format={(value) => (value === 0 ? 'Off' : percent(value))}
          onCommit={(motionBlur) => onChange({ ...style, motionBlur })}
        />
        <p className="field-note">
          Blurs the picture while the camera zooms or pans, never while it holds.
        </p>
      </Section>
    </div>
  );
}
