import type { ReactNode } from 'react';

import type { EffectDto } from '@usee/contracts';
import type { CameraPreset } from '@usee/domain';

type ZoomDto = Extract<EffectDto, { kind: 'zoom' }>;

/** A small drawing of each move: the frame as the camera ends up seeing it. */
const GLYPHS: Readonly<Record<CameraPreset, ReactNode>> = {
  'push-in': (
    <>
      <rect x="2.5" y="4.5" width="19" height="15" rx="2" className="faint" />
      <rect x="7" y="8" width="10" height="8" rx="1.5" />
      <path d="M4.5 6.5 7 8.5M19.5 6.5 17 8.5M4.5 17.5 7 15.5M19.5 17.5 17 15.5" />
    </>
  ),
  'pull-out': (
    <>
      <rect x="7" y="8" width="10" height="8" rx="1.5" className="faint" />
      <rect x="2.5" y="4.5" width="19" height="15" rx="2" />
      <path d="M8.5 9.5 6 7.5M15.5 9.5 18 7.5M8.5 14.5 6 16.5M15.5 14.5 18 16.5" />
    </>
  ),
  'tilt-up': (
    <>
      <path d="M7 6.5h10l3.5 11h-17z" />
      <path d="M12 4.5v-2M10.5 4 12 2.5 13.5 4" />
    </>
  ),
  swing: (
    <>
      <path d="M6 7.5 17 5v14L6 16.5z" />
      <path d="M3.5 19.5c2.5 2 14.5 2 17 0M18.5 18.2l2 1.3-1.6 1.8" />
    </>
  ),
  orbit: (
    <>
      <rect x="8" y="8.5" width="8" height="7" rx="1.2" />
      <ellipse cx="12" cy="12" rx="10" ry="4.5" className="faint" />
      <path d="M19.5 9.2 21.6 11l-2.6.9" />
    </>
  ),
};

/** The built-in 3D moves, as the editor names them, in the order it offers them. */
export const CAMERA_MOVES: readonly { readonly preset: CameraPreset; readonly label: string }[] = [
  { preset: 'push-in', label: 'Push in' },
  { preset: 'pull-out', label: 'Pull out' },
  { preset: 'tilt-up', label: 'Tilt up' },
  { preset: 'swing', label: 'Swing' },
  { preset: 'orbit', label: 'Orbit' },
];

/** The move "Add 3D zoom" starts with: the one that most plainly turns. */
export const DEFAULT_CAMERA_MOVE: CameraPreset = 'swing';

/** One button per move, each with a drawing of it. */
export function CameraMoveButtons({
  onApply,
}: {
  readonly onApply: (preset: CameraPreset) => void;
}) {
  return (
    <div className="move-grid">
      {CAMERA_MOVES.map(({ preset, label }) => (
        <button key={preset} type="button" className="move" onClick={() => onApply(preset)}>
          <svg className="move-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            {GLYPHS[preset]}
          </svg>
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

/** Whether a zoom moves in 3D: any keyframe turned, or pulled back past the frame. */
export function zoomIs3d(zoom: ZoomDto): boolean {
  return (
    zoom.lens !== undefined ||
    zoom.poses.some(({ value }) => {
      const { rotation } = value;
      return (
        value.scale < 1 ||
        (rotation !== undefined && (rotation.x !== 0 || rotation.y !== 0 || rotation.z !== 0))
      );
    })
  );
}
