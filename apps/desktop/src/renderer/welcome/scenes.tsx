import { useStore } from 'zustand';

import { LOOK_SWATCHES, lookOf, NO_BACKGROUND } from '../settings/looks';
import type { SettingsStore } from '../settings/settings-store';

/**
 * The welcome tour's pictures (Welcome.tsx). Each is drawn here and moved by
 * styles.css on a loop; with less motion asked for, each holds its key frame.
 */

/** A code editor's lines: [x, y, width, tone]. */
const CODE_LINES: readonly (readonly [number, number, number, string])[] = [
  [34, 50, 72, 'muted'],
  [34, 64, 128, 'depth'],
  [46, 78, 96, 'muted'],
  [46, 92, 150, 'tally'],
  [34, 106, 84, 'muted'],
  [46, 120, 110, 'muted'],
  [34, 134, 60, 'depth'],
  [34, 148, 132, 'muted'],
  [46, 162, 70, 'muted'],
];

/** The arrow cursor, its tip at the origin. */
const CURSOR = 'M0 0v15.5l4.2-3.9 2.6 6 2.9-1.3-2.6-5.9h5.6z';

function CodeWindow() {
  return (
    <>
      <rect className="scene-window" x="18" y="16" width="284" height="168" rx="9" />
      <path className="scene-titlebar" d="M27 16h266a9 9 0 0 1 9 9v11H18V25a9 9 0 0 1 9-9z" />
      <rect className="scene-control" x="262" y="24" width="8" height="2" rx="1" />
      <rect className="scene-control" x="278" y="21" width="8" height="8" rx="1.5" />
      {CODE_LINES.map(([x, y, width, tone]) => (
        <rect
          key={y}
          className={`scene-line ${tone}`}
          x={x}
          y={y}
          width={width}
          height="6"
          rx="3"
        />
      ))}
    </>
  );
}

/** A click on a button, and the camera moving in on it and back out. */
export function AutoZoomScene() {
  return (
    <svg className="scene" viewBox="0 0 320 200" aria-hidden="true" focusable="false">
      <defs>
        <clipPath id="scene-zoom-frame">
          <rect width="320" height="200" rx="14" />
        </clipPath>
      </defs>
      <g clipPath="url(#scene-zoom-frame)">
        <rect className="scene-desk" width="320" height="200" />
        <g className="zoom-camera">
          <CodeWindow />
          <rect className="scene-button" x="196" y="128" width="58" height="20" rx="6" />
          <text className="scene-button-label" x="225" y="141.5">
            Run
          </text>
          <circle className="zoom-ripple" cx="225" cy="138" r="13" />
          <g transform="translate(225 138)">
            <path className="zoom-cursor" d={CURSOR} />
          </g>
        </g>
      </g>
    </svg>
  );
}

/** An area drawn over the desktop, the three-second countdown, then the recording light. */
export function AreaScene() {
  return (
    <svg className="scene" viewBox="0 0 320 200" aria-hidden="true" focusable="false">
      <defs>
        <clipPath id="scene-area-frame">
          <rect width="320" height="200" rx="14" />
        </clipPath>
      </defs>
      <g clipPath="url(#scene-area-frame)">
        <rect className="scene-desk" width="320" height="200" />
        <rect className="scene-window" x="22" y="22" width="150" height="104" rx="8" />
        <path className="scene-titlebar" d="M30 22h134a8 8 0 0 1 8 8v8H22v-8a8 8 0 0 1 8-8z" />
        <rect className="scene-window" x="132" y="70" width="168" height="112" rx="8" />
        <path className="scene-titlebar" d="M140 70h152a8 8 0 0 1 8 8v8H132v-8a8 8 0 0 1 8-8z" />
        <rect className="scene-line muted" x="146" y="100" width="96" height="6" rx="3" />
        <rect className="scene-line depth" x="146" y="114" width="130" height="6" rx="3" />
        <rect className="scene-line muted" x="146" y="128" width="72" height="6" rx="3" />
        <path className="area-dim" fillRule="evenodd" d="M0 0h320v200H0zM110 52v100h150V52z" />
        <rect className="area-selection" x="110" y="52" width="150" height="100" rx="3" />
        <g className="area-badge">
          <circle cx="185" cy="102" r="21" />
          <text className="area-count three" x="185" y="110">
            3
          </text>
          <text className="area-count two" x="185" y="110">
            2
          </text>
          <text className="area-count one" x="185" y="110">
            1
          </text>
        </g>
        <g className="area-live">
          <circle cx="238" cy="64" r="4.5" />
          <text x="246" y="67.5">
            REC
          </text>
        </g>
      </g>
    </svg>
  );
}

/** A recording going into a folder on this computer, and the cloud left out. */
export function PrivacyScene() {
  return (
    <svg className="scene" viewBox="0 0 320 200" aria-hidden="true" focusable="false">
      <rect className="scene-window" x="70" y="26" width="180" height="118" rx="10" />
      <rect className="scene-desk" x="78" y="34" width="164" height="102" rx="6" />
      <path className="scene-stand" d="M146 144h28l6 16h-40z" />
      <rect className="scene-stand" x="124" y="160" width="72" height="6" rx="3" />
      <path
        className="privacy-folder-back"
        d="M128 74a4 4 0 0 1 4-4h16l5 5h35a4 4 0 0 1 4 4v4h-64z"
      />
      <g className="privacy-file">
        <rect x="140" y="44" width="40" height="26" rx="4" />
        <path d="M156 51.5v11l8.5-5.5z" />
      </g>
      <rect className="privacy-folder" x="128" y="80" width="64" height="44" rx="5" />
      <g className="privacy-lock">
        <circle cx="190" cy="120" r="10" />
        <path d="M186 119.5v-2.5a4 4 0 0 1 8 0v2.5" />
        <rect x="184.5" y="119" width="11" height="8" rx="2" />
      </g>
      <g className="privacy-cloud">
        <path d="M268 50h28a9 9 0 0 0 0-18 13 13 0 0 0-25-3 8 8 0 0 0-3 21z" />
        <path className="privacy-slash" d="M262 56l40-34" />
      </g>
    </svg>
  );
}

/** The looks chosen on the last step, on a small frame that moves as a recording would. */
export function LooksScene({ settings }: { readonly settings: SettingsStore }) {
  const looks = useStore(settings, (state) => state.settings?.newProjects);
  if (looks === undefined) {
    return null;
  }
  const swatch = LOOK_SWATCHES.find(({ id }) => id === lookOf(looks.canvas)) ?? NO_BACKGROUND;
  const framed = swatch.id !== NO_BACKGROUND.id;
  const classes = ['looks-frame'];
  if (framed) classes.push('framed');
  if (looks.autoZoom) classes.push('zooming');
  if (looks.autoZoom && looks.turn3d > 0) classes.push('turning');
  return (
    <div className="looks-scene" style={{ background: framed ? swatch.paint : '#0b1020' }}>
      <div className={classes.join(' ')}>
        <svg className="looks-picture" viewBox="0 0 320 200" aria-hidden="true" focusable="false">
          <rect className="scene-desk" width="320" height="200" />
          <g className="looks-camera">
            <CodeWindow />
            <rect className="scene-button" x="196" y="128" width="58" height="20" rx="6" />
            <g transform="translate(225 138)">
              <path className="looks-cursor" d={CURSOR} />
            </g>
          </g>
        </svg>
      </div>
    </div>
  );
}
