import { useStore } from 'zustand';

import type { NewProjectDefaults } from '@usee/contracts';

import { Swatches, Switch } from '../editor/ui';
import { canvasForLook, LOOK_SWATCHES, lookOf } from './looks';
import type { SettingsStore } from './settings-store';

/** How far a newly turned-on 3D motion turns, as the editor's switch does. */
const DEFAULT_TURN = 0.6;

/** The looks every new recording starts with: the editor's main ones, one click each. */
export function LookChoices({ settings }: { readonly settings: SettingsStore }) {
  const looks = useStore(settings, (state) => state.settings?.newProjects);
  if (looks === undefined) {
    return null;
  }
  const change = (patch: Partial<NewProjectDefaults>) =>
    void settings.getState().update({ newProjects: { ...looks, ...patch } });
  return (
    <>
      <Switch
        label="Auto zoom on clicks"
        checked={looks.autoZoom}
        onChange={(autoZoom) => change({ autoZoom })}
      />
      <Switch
        label="3D motion toward each action"
        checked={looks.turn3d > 0}
        disabled={!looks.autoZoom}
        onChange={(on) => change({ turn3d: on ? DEFAULT_TURN : 0 })}
      />
      <div className="field">
        <span className="field-label">Background</span>
        <Swatches
          label="Background"
          swatches={LOOK_SWATCHES}
          selected={lookOf(looks.canvas)}
          onPick={(swatch) => change({ canvas: canvasForLook(swatch.id) })}
        />
      </div>
    </>
  );
}
