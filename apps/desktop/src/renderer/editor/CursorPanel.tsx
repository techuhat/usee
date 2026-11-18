import type { CursorSettingsDto } from '@usee/contracts';

import { ColorField, CommitSlider } from './controls';
import { Section, Segmented, Swatches, Switch, type Choice } from './ui';

type ClickEffect = CursorSettingsDto['clickEffect'];

const CLICK_EFFECTS: readonly Choice<ClickEffect>[] = [
  { value: 'none', label: 'None', icon: <span className="click-glyph glyph-none" /> },
  { value: 'ripple', label: 'Ripple', icon: <span className="click-glyph glyph-ripple" /> },
  { value: 'pulse', label: 'Pulse', icon: <span className="click-glyph glyph-pulse" /> },
  { value: 'ring', label: 'Ring', icon: <span className="click-glyph glyph-ring" /> },
  { value: 'bounce', label: 'Bounce', icon: <span className="click-glyph glyph-bounce" /> },
];

const CURSOR_COLOURS = [
  { id: '#ffffff', name: 'White', paint: '#ffffff' },
  { id: '#1a1c24', name: 'Black', paint: '#1a1c24' },
  { id: '#ffd23f', name: 'Yellow', paint: '#ffd23f' },
  { id: '#ff5a7a', name: 'Rose', paint: '#ff5a7a' },
  { id: '#4cc9f0', name: 'Cyan', paint: '#4cc9f0' },
  { id: '#7c5cff', name: 'Violet', paint: '#7c5cff' },
] as const;

/** How the recorded cursor is drawn, for the whole project. */
export function CursorPanel({
  settings,
  hasPointer,
  onChange,
}: {
  readonly settings: CursorSettingsDto;
  readonly hasPointer: boolean;
  readonly onChange: (settings: CursorSettingsDto) => void;
}) {
  const change = (patch: Partial<CursorSettingsDto>) => onChange({ ...settings, ...patch });
  const color = settings.color ?? '#ffffff';
  const off = !hasPointer;
  return (
    <div className="inspector-body" data-testid="cursor-panel">
      {off && (
        <p className="field-note">
          This recording has no recorded pointer, so there is no cursor to draw.
        </p>
      )}
      <Section title="Cursor">
        <Switch
          label="Show the cursor"
          checked={settings.visible}
          disabled={off}
          onChange={(visible) => change({ visible })}
        />
        <CommitSlider
          label="Size"
          value={settings.size}
          min={0.5}
          max={3}
          step={0.1}
          format={(value) => `${value.toFixed(1)}×`}
          disabled={off}
          onCommit={(size) => change({ size })}
        />
        <CommitSlider
          label="Smoothing"
          value={settings.smoothing}
          min={0}
          max={1}
          step={0.05}
          format={(value) => `${Math.round(value * 100)}%`}
          disabled={off}
          onCommit={(smoothing) => change({ smoothing })}
        />
      </Section>

      <Section title="Colour">
        <Swatches
          label="Cursor colour"
          swatches={CURSOR_COLOURS}
          selected={CURSOR_COLOURS.find((swatch) => swatch.id === color.toLowerCase())?.id}
          disabled={off}
          onPick={(swatch) => change({ color: swatch.id })}
        />
        <ColorField
          label="Custom"
          value={color}
          disabled={off}
          onCommit={(picked) => change({ color: picked })}
        />
      </Section>

      <Section title="Clicks">
        <Segmented
          label="Clicks"
          value={settings.clickEffect}
          choices={CLICK_EFFECTS}
          columns={5}
          disabled={off}
          onChange={(clickEffect) => change({ clickEffect })}
        />
      </Section>

      <Section title="Spotlight">
        <CommitSlider
          label="Spotlight"
          value={settings.spotlight ?? 0}
          min={0}
          max={1}
          step={0.05}
          format={(value) => (value === 0 ? 'Off' : `${Math.round(value * 100)}%`)}
          disabled={off}
          onCommit={(spotlight) => change({ spotlight })}
        />
        <p className="field-note">Dims the picture away from the cursor, so the eye follows it.</p>
      </Section>
    </div>
  );
}
