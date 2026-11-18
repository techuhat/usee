import { err, ok, type ClipId, type Result } from '@usee/contracts';

import { findGeneratedZoom } from './analysis';
import { cursorSettingsProblem, MAX_ZOOM_SCALE } from './effect-rules';
import { canvasStyleProblem, type CanvasStyle } from './canvas';
import type { CursorSettings, Effect } from './effects';
import type { Project } from './project';
import {
  applyTimelineCommand,
  type TimelineCommand,
  type TimelineEditContext,
  type TimelineEditError,
} from './timeline-edit';

/**
 * Every semantic edit of a project: timeline edits, the project-wide cursor
 * settings, and the manual overrides of the generated camera layer.
 */
export type ProjectCommand =
  | TimelineCommand
  | { readonly type: 'set-cursor'; readonly settings: CursorSettings }
  | { readonly type: 'set-canvas'; readonly style: CanvasStyle }
  | {
      readonly type: 'set-auto-zoom';
      readonly enabled: boolean;
      readonly scale: number;
      /** Left as it is when absent. */
      readonly turn3d?: number;
    }
  /** Turns one generated zoom off, or back on. */
  | { readonly type: 'set-generated-zoom'; readonly zoomId: string; readonly enabled: boolean }
  /**
   * Turns a generated zoom off and gives each clip it shows over (a cut can
   * run through it) its own effect in its place, as one step.
   */
  | {
      readonly type: 'take-over-generated-zoom';
      readonly zoomId: string;
      readonly effects: readonly { readonly clipId: ClipId; readonly effect: Effect }[];
    };

export type ProjectEditError = TimelineEditError | 'settings-invalid' | 'generated-zoom-not-found';

/** The project with `zoomId` turned off or on; the same project when nothing changes. */
function withGeneratedZoom(project: Project, zoomId: string, enabled: boolean): Project {
  const { autoZoom } = project.settings;
  const off = autoZoom.disabled.includes(zoomId);
  if (off === !enabled) {
    return project;
  }
  const disabled = enabled
    ? autoZoom.disabled.filter((id) => id !== zoomId)
    : [...autoZoom.disabled, zoomId];
  return { ...project, settings: { ...project.settings, autoZoom: { ...autoZoom, disabled } } };
}

function sameCanvas(a: CanvasStyle, b: CanvasStyle): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameSettings(a: CursorSettings, b: CursorSettings): boolean {
  return (
    a.visible === b.visible &&
    a.size === b.size &&
    a.smoothing === b.smoothing &&
    a.clickEffect === b.clickEffect &&
    a.color === b.color &&
    a.spotlight === b.spotlight
  );
}

/**
 * Applies one command. A command that changes nothing returns the same
 * project object, so callers can keep it out of the undo history.
 */
export function applyProjectCommand(
  project: Project,
  command: ProjectCommand,
  context: Omit<TimelineEditContext, 'assets'>,
): Result<Project, ProjectEditError> {
  switch (command.type) {
    case 'set-cursor':
      if (cursorSettingsProblem(command.settings) !== undefined) {
        return err('settings-invalid');
      }
      if (sameSettings(project.settings.cursor, command.settings)) {
        return ok(project);
      }
      return ok({ ...project, settings: { ...project.settings, cursor: command.settings } });
    case 'set-canvas':
      if (canvasStyleProblem(command.style) !== undefined) {
        return err('settings-invalid');
      }
      if (sameCanvas(project.settings.canvas, command.style)) {
        return ok(project);
      }
      return ok({ ...project, settings: { ...project.settings, canvas: command.style } });
    case 'set-auto-zoom': {
      if (
        !(command.scale >= 1 && command.scale <= MAX_ZOOM_SCALE) ||
        (command.turn3d !== undefined && !(command.turn3d >= 0 && command.turn3d <= 1))
      ) {
        return err('settings-invalid');
      }
      const { autoZoom } = project.settings;
      const turn3d = command.turn3d ?? autoZoom.turn3d;
      if (
        autoZoom.enabled === command.enabled &&
        autoZoom.scale === command.scale &&
        autoZoom.turn3d === turn3d
      ) {
        return ok(project);
      }
      return ok({
        ...project,
        settings: {
          ...project.settings,
          autoZoom: {
            ...autoZoom,
            enabled: command.enabled,
            scale: command.scale,
            ...(turn3d === undefined ? {} : { turn3d }),
          },
        },
      });
    }
    case 'set-generated-zoom':
      return findGeneratedZoom(project.analysisRuns, command.zoomId) === undefined
        ? err('generated-zoom-not-found')
        : ok(withGeneratedZoom(project, command.zoomId, command.enabled));
    case 'take-over-generated-zoom': {
      if (findGeneratedZoom(project.analysisRuns, command.zoomId) === undefined) {
        return err('generated-zoom-not-found');
      }
      let edited = project;
      for (const { clipId, effect } of command.effects) {
        const added = applyProjectCommand(edited, { type: 'add-effect', clipId, effect }, context);
        if (!added.ok) {
          return added;
        }
        edited = added.value;
      }
      return ok(withGeneratedZoom(edited, command.zoomId, false));
    }
    case 'split':
    case 'delete':
    case 'trim':
    case 'add-effect':
    case 'update-effect':
    case 'remove-effect':
    case 'set-clip-speed': {
      const edited = applyTimelineCommand(project.timeline, command, {
        ...context,
        assets: project.assets,
      });
      if (!edited.ok) {
        return edited;
      }
      return edited.value === project.timeline
        ? ok(project)
        : ok({ ...project, timeline: edited.value });
    }
  }
}
