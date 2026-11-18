import { useRef, useState, type CSSProperties } from 'react';

export interface CommitSliderProps {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly format: (value: number) => string;
  /** The value a gesture ended on, sent once when it differs from `value`. */
  readonly onCommit: (value: number) => void;
  readonly disabled?: boolean;
}

/**
 * A range input that sends one change per gesture: it follows the pointer
 * or the keys locally and commits when they let go (docs/state-management.md).
 * While it has focus it shows its own value, so the snapshots of the edits
 * it sent never move it back under the pointer or between key presses.
 */
export function CommitSlider({
  label,
  value,
  min,
  max,
  step,
  format,
  onCommit,
  disabled = false,
}: CommitSliderProps) {
  const [local, setLocal] = useState<number | null>(null);
  const sent = useRef<number | null>(null);
  const shown = local ?? value;
  const commit = () => {
    if (local !== null && local !== value && local !== sent.current) {
      sent.current = local;
      onCommit(local);
    }
  };
  return (
    <label className="slider">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        disabled={disabled}
        // How far along the track is filled, for its styling.
        style={{ '--fill': `${((shown - min) / (max - min)) * 100}%` } as CSSProperties}
        onChange={(event) => setLocal(Number(event.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={() => {
          commit();
          sent.current = null;
          setLocal(null);
        }}
      />
      <output>{format(shown)}</output>
    </label>
  );
}

/**
 * A line of text that commits once, when it loses focus or Enter is pressed,
 * so typing is one edit; left empty, it goes back to what it was.
 */
export function TextField({
  label,
  value,
  maxLength,
  onCommit,
}: {
  readonly label: string;
  readonly value: string;
  readonly maxLength: number;
  readonly onCommit: (text: string) => void;
}) {
  const [local, setLocal] = useState<string | null>(null);
  const commit = () => {
    if (local !== null && local.trim() !== '' && local !== value) {
      onCommit(local);
    }
    setLocal(null);
  };
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="text"
        value={local ?? value}
        maxLength={maxLength}
        spellCheck={false}
        onChange={(event) => setLocal(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            setLocal(null);
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

/** A colour picker that commits once, when it closes, so a drag is one edit. */
export function ColorField({
  label,
  value,
  onCommit,
  disabled = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly onCommit: (color: string) => void;
  readonly disabled?: boolean;
}) {
  const [local, setLocal] = useState<string | null>(null);
  return (
    <label className="field color-field">
      <span>{label}</span>
      <input
        type="color"
        value={(local ?? value).slice(0, 7)}
        disabled={disabled}
        onChange={(event) => setLocal(event.target.value)}
        onBlur={() => {
          if (local !== null && local !== value) {
            onCommit(local);
          }
          setLocal(null);
        }}
      />
    </label>
  );
}
