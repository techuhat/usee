import type { ReactNode } from 'react';

import type { ProjectSnapshot } from '@usee/contracts';

import type { AutoZoomBar } from './auto-zoom';
import { CommitSlider } from './controls';
import { formatTimecode } from './timecode';
import { Section, Switch } from './ui';
import type { PictureAnalysisState } from './use-picture-analysis';

type AutoZoomSettings = ProjectSnapshot['autoZoom'];

/**
 * The 3D camera tab: the 3D moves a zoom can take, then the generated camera
 * for the whole project, whether it turns toward each action, zooms in on
 * clicks, and how far.
 */
export function AutoZoomPanel({
  moves,
  movesNote,
  settings,
  zoomCount,
  hasPointer,
  pictureFocus,
  picture,
  onPictureFocus,
  onChange,
}: {
  /** The 3D move buttons, which add a zoom or change the selected one. */
  readonly moves: ReactNode;
  readonly movesNote: string;
  readonly settings: AutoZoomSettings;
  /** How many zooms were generated, turned off or not. */
  readonly zoomCount: number;
  readonly hasPointer: boolean;
  /** Whether the camera also looks where the picture changes (a setting for every recording). */
  readonly pictureFocus: boolean;
  readonly picture: PictureAnalysisState;
  readonly onPictureFocus: (on: boolean) => void;
  readonly onChange: (settings: {
    readonly enabled: boolean;
    readonly scale: number;
    readonly turn3d?: number;
  }) => void;
}) {
  const turn3d = settings.turn3d ?? 0;
  const off = !hasPointer || !settings.enabled;
  return (
    <div className="inspector-body" data-testid="auto-zoom-panel">
      <Section title="3D moves">
        {moves}
        <p className="field-note">{movesNote}</p>
      </Section>
      <Section title="3D motion">
        <Switch
          label="Turn toward each action"
          checked={turn3d > 0}
          disabled={off}
          onChange={(on) =>
            onChange({ enabled: settings.enabled, scale: settings.scale, turn3d: on ? 0.6 : 0 })
          }
        />
        <CommitSlider
          label="Turn"
          value={turn3d}
          min={0.1}
          max={1}
          step={0.05}
          format={(value) => `${Math.round(value * 100)}%`}
          disabled={off || turn3d === 0}
          onCommit={(value) =>
            onChange({ enabled: settings.enabled, scale: settings.scale, turn3d: value })
          }
        />
        <p className="field-note">
          {off
            ? 'The automatic camera turns toward each action once Zoom in on clicks, below, is on.'
            : 'The camera pushes in toward each action with a gentle turn, glides between them and pulls back out, so the recording gets depth without keyframes.'}
        </p>
      </Section>
      <Section title="Auto zoom">
        <p className="field-note">
          {!hasPointer
            ? 'This recording has no recorded pointer, so there are no clicks to zoom in on.'
            : zoomCount === 0
              ? 'There are no clicks to zoom in on.'
              : !settings.enabled
                ? 'Turned off: only your own zooms move the camera.'
                : `${zoomCount} ${zoomCount === 1 ? 'zoom follows' : 'zooms follow'} your clicks; your own zooms take their place where they meet.`}
        </p>
        <Switch
          label="Zoom in on clicks"
          checked={settings.enabled}
          disabled={!hasPointer}
          onChange={(enabled) => onChange({ enabled, scale: settings.scale })}
        />
        <CommitSlider
          label="Depth"
          value={settings.scale}
          min={1.2}
          max={4}
          step={0.1}
          format={(value) => `${value.toFixed(1)}×`}
          disabled={!hasPointer || !settings.enabled}
          onCommit={(scale) => onChange({ enabled: settings.enabled, scale })}
        />
        <Switch
          label="Follow changes on screen"
          checked={pictureFocus}
          disabled={!hasPointer || !settings.enabled}
          onChange={onPictureFocus}
        />
        <p className="field-note" role="status" data-testid="picture-focus-status">
          {pictureNote(pictureFocus, picture)}
        </p>
      </Section>
    </div>
  );
}

/** What picture focus is doing, in a line. */
function pictureNote(on: boolean, picture: PictureAnalysisState): string {
  if (!on) {
    return 'The camera can also look where menus, dialogs and typing change the picture. It reads each recording in the background, never keystrokes, in every project.';
  }
  switch (picture.status) {
    case 'reading':
      return `Reading the picture… ${Math.round(picture.progress * 100)}%`;
    case 'done':
      return 'The camera also looks where the picture changes.';
    case 'unsupported':
      return 'This recording’s picture cannot be read here, so the camera follows the pointer.';
    case 'failed':
      return 'Reading the picture failed, so the camera follows the pointer.';
    case 'off':
      return 'The camera also looks where the picture changes, once it has read it.';
  }
}

/** A selected generated zoom: turn it off, or take it over to change it. */
export function AutoZoomInspector({
  bar,
  onToggle,
  onTakeOver,
}: {
  readonly bar: AutoZoomBar;
  readonly onToggle: (enabled: boolean) => void;
  readonly onTakeOver: () => void;
}) {
  return (
    <div className="inspector-body" data-testid="effect-inspector">
      <Section
        title="Automatic zoom"
        aside={
          <span className="section-note">
            {formatTimecode(bar.startUs)} – {formatTimecode(bar.endUs)}
          </span>
        }
      >
        <Switch label="Use this zoom" checked={!bar.disabled} onChange={onToggle} />
        <p className="field-note">It closes in on the clicks in this stretch.</p>
      </Section>
      <Section title="Make it your own">
        <button type="button" onClick={onTakeOver}>
          Edit as my own zoom
        </button>
        <p className="field-note">
          Your own zoom takes its place, ready to aim, retime and keyframe, and this one turns off.
        </p>
      </Section>
    </div>
  );
}
