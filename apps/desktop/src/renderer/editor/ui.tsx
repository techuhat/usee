import type { KeyboardEvent, ReactNode } from 'react';

/** A titled group of controls in the inspector, set apart by space and a quiet rule. */
export function Section({
  title,
  children,
  aside,
}: {
  readonly title: string;
  readonly children: ReactNode;
  /** A short note or control beside the title. */
  readonly aside?: ReactNode;
}) {
  return (
    <section className="section">
      <header className="section-head">
        <h3>{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  );
}

export interface Choice<Value extends string> {
  readonly value: Value;
  readonly label: string;
  /** Shown above the label, when the choice is easier to see than to read. */
  readonly icon?: ReactNode;
  readonly title?: string;
}

/**
 * Moves the chosen item of a radio group or tab list with the arrow keys, then
 * focuses it: `chosen` selects it once the change has rendered.
 */
export function arrowTo<Value extends string>(
  event: KeyboardEvent<HTMLElement>,
  values: readonly Value[],
  current: Value,
  onChange: (value: Value) => void,
  chosen = '[aria-checked="true"]',
): void {
  const step =
    event.key === 'ArrowRight' || event.key === 'ArrowDown'
      ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
        ? -1
        : 0;
  if (step === 0) {
    return;
  }
  event.preventDefault();
  const index = values.indexOf(current);
  const next = values.at((index + step + values.length) % values.length);
  if (next !== undefined) {
    onChange(next);
    const group = event.currentTarget;
    requestAnimationFrame(() => group.querySelector<HTMLElement>(chosen)?.focus());
  }
}

/**
 * One choice of a few, shown side by side: a radio group of buttons, so each
 * option reads as what it does. `columns` wraps a long set into rows.
 */
export function Segmented<Value extends string>({
  label,
  value,
  choices,
  onChange,
  disabled = false,
  columns,
}: {
  readonly label: string;
  readonly value: Value;
  readonly choices: readonly Choice<Value>[];
  readonly onChange: (value: Value) => void;
  readonly disabled?: boolean;
  readonly columns?: number;
}) {
  return (
    <div
      className="segmented"
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled}
      style={columns === undefined ? undefined : { gridTemplateColumns: `repeat(${columns}, 1fr)` }}
      onKeyDown={(event) =>
        arrowTo(
          event,
          choices.map((choice) => choice.value),
          value,
          onChange,
        )
      }
    >
      {choices.map((choice) => {
        const checked = choice.value === value;
        return (
          <button
            key={choice.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            title={choice.title}
            className={checked ? 'segment checked' : 'segment'}
            onClick={() => onChange(choice.value)}
          >
            {choice.icon}
            <span>{choice.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export interface Swatch {
  readonly id: string;
  readonly name: string;
  /** What the swatch shows: any CSS background. */
  readonly paint: string;
}

/** A grid of colours or gradients to pick from, as a radio group. */
export function Swatches({
  label,
  swatches,
  selected,
  onPick,
  disabled = false,
}: {
  readonly label: string;
  readonly swatches: readonly Swatch[];
  /** The ID of the swatch that matches what is set, if one does. */
  readonly selected: string | undefined;
  readonly onPick: (swatch: Swatch) => void;
  readonly disabled?: boolean;
}) {
  const current = selected ?? swatches[0]?.id ?? '';
  return (
    <div
      className="swatches"
      role="radiogroup"
      aria-label={label}
      onKeyDown={(event) =>
        arrowTo(
          event,
          swatches.map((swatch) => swatch.id),
          current,
          (id) => {
            const swatch = swatches.find((candidate) => candidate.id === id);
            if (swatch !== undefined) {
              onPick(swatch);
            }
          },
        )
      }
    >
      {swatches.map((swatch) => {
        const checked = swatch.id === selected;
        return (
          <button
            key={swatch.id}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={swatch.name}
            title={swatch.name}
            tabIndex={swatch.id === current ? 0 : -1}
            disabled={disabled}
            className={checked ? 'swatch checked' : 'swatch'}
            style={{ background: swatch.paint }}
            onClick={() => onPick(swatch)}
          />
        );
      })}
    </div>
  );
}

/** An on/off setting, drawn as a switch but read as the checkbox it is. */
export function Switch({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
}) {
  return (
    <label className="switch">
      <span>{label}</span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

/** Line icons, drawn in the current text colour. */
export function Icon({ name }: { readonly name: IconName }) {
  return (
    <svg className="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      {ICONS[name]}
    </svg>
  );
}

export type IconName =
  | 'back'
  | 'play'
  | 'pause'
  | 'undo'
  | 'redo'
  | 'zoom'
  | 'blur'
  | 'split'
  | 'trash'
  | 'edit'
  | 'canvas'
  | 'cursor'
  | 'camera'
  | 'cube'
  | 'home'
  | 'library'
  | 'settings'
  | 'folder'
  | 'refresh'
  | 'text';

const ICONS: Readonly<Record<IconName, ReactNode>> = {
  back: <path d="M12.5 4.5 7 10l5.5 5.5" />,
  play: <path d="M6.5 4.5v11l9-5.5z" className="filled" />,
  pause: (
    <>
      <rect x="5.5" y="4.5" width="3" height="11" rx="0.8" className="filled" />
      <rect x="11.5" y="4.5" width="3" height="11" rx="0.8" className="filled" />
    </>
  ),
  undo: <path d="M7.5 6.5H12a4 4 0 0 1 0 8H8M7.5 6.5l2.5-2.5M7.5 6.5 10 9" />,
  redo: <path d="M12.5 6.5H8a4 4 0 0 0 0 8h4M12.5 6.5 10 4M12.5 6.5 10 9" />,
  zoom: (
    <>
      <circle cx="9" cy="9" r="4.5" />
      <path d="m12.5 12.5 3.5 3.5M9 6.8v4.4M6.8 9h4.4" />
    </>
  ),
  blur: (
    <>
      <path d="M10 3.5s4.5 4.6 4.5 7.8a4.5 4.5 0 0 1-9 0C5.5 8.1 10 3.5 10 3.5z" />
      <path d="M8 12a2 2 0 0 0 2 2" />
    </>
  ),
  split: (
    <>
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="14" r="2" />
      <path d="m7.6 7.2 8.4 7.3M7.6 12.8 16 5.5" />
    </>
  ),
  trash: <path d="M4.5 6h11M8 6V4.5h4V6M6 6l.8 9.5h6.4L14 6" />,
  edit: <path d="M4.5 15.5v-2.8l8.4-8.4 2.8 2.8-8.4 8.4zM11.4 5.8l2.8 2.8" />,
  canvas: (
    <>
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <rect x="6" y="7" width="8" height="6" rx="1" />
    </>
  ),
  cursor: <path d="M5.5 3.5v12l3.4-3.3 2.3 5 2-.9-2.3-4.9h4.6z" />,
  camera: (
    <>
      <rect x="2.5" y="6" width="11" height="9" rx="1.8" />
      <path d="m13.5 9.5 4-2.3v6.6l-4-2.3" />
    </>
  ),
  cube: (
    <>
      <path d="M10 2.8 16.4 6.4v7.2L10 17.2l-6.4-3.6V6.4z" />
      <path d="M3.6 6.4 10 10l6.4-3.6M10 10v7.2" />
    </>
  ),
  home: <path d="M3.5 9.2 10 3.8l6.5 5.4M5.5 7.8v8.4h3.2v-4.4h2.6v4.4h3.2V7.8" />,
  refresh: <path d="M15.5 10a5.5 5.5 0 1 1-5.5-5.5c1.6 0 3.1.6 4.2 1.7l1.3 1.3M15.5 4v3.5H12" />,
  text: <path d="M4.5 5.5V4h11v1.5M10 4v12M7.5 16h5" />,
  library: (
    <>
      <rect x="2.8" y="4.8" width="14.4" height="10.4" rx="2" />
      <path d="M8.6 7.9v4.2l3.6-2.1z" className="filled" />
    </>
  ),
  settings: (
    <>
      <path d="M3.5 6h13M3.5 10h13M3.5 14h13" />
      <circle cx="7.5" cy="6" r="1.7" className="filled" />
      <circle cx="12.8" cy="10" r="1.7" className="filled" />
      <circle cx="9" cy="14" r="1.7" className="filled" />
    </>
  ),
  folder: (
    <path d="M3 6a1.2 1.2 0 0 1 1.2-1.2h3.6L9.6 6.6h6.2A1.2 1.2 0 0 1 17 7.8v6.9a1.2 1.2 0 0 1-1.2 1.2H4.2A1.2 1.2 0 0 1 3 14.7z" />
  ),
};
