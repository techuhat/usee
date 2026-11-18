import { describe, expect, it } from 'vitest';

import {
  asAssetId,
  asClipId,
  asDurationUs,
  asEffectId,
  asProjectId,
  asRecordingSessionId,
  asSchemaVersion,
  asTimelineId,
  asTimestampUs,
  asTrackId,
} from '@usee/contracts';

import { DEFAULT_AUTO_ZOOM_SETTINGS } from './analysis';
import { DEFAULT_CANVAS_STYLE } from './canvas';
import { DEFAULT_CURSOR_SETTINGS, type ZoomEffect } from './effects';
import type { Project } from './project';
import { applyProjectCommand } from './project-edit';

const SECOND = 1_000_000;

const project: Project = {
  id: asProjectId('project'),
  schemaVersion: asSchemaVersion(1),
  title: 'Recording',
  createdAtUs: asTimestampUs(0),
  updatedAtUs: asTimestampUs(0),
  assets: [
    {
      id: asAssetId('recording'),
      kind: 'video',
      createdAtUs: asTimestampUs(0),
      durationUs: asDurationUs(10 * SECOND),
      relativePath: 'media/originals/s/recording.mp4',
      dimensions: { width: 1920, height: 1080 },
      frameRate: { numerator: 60, denominator: 1 },
      hasAudio: false,
      sessionStartUs: asTimestampUs(0),
    },
  ],
  recordingSessions: [],
  analysisRuns: [
    {
      kind: 'camera-track',
      id: 's-camera',
      sessionId: asRecordingSessionId('s'),
      provenance: {
        strategy: 'click-focus',
        strategyVersion: 1,
        producer: 'usee 0.1.0',
        inputSha256: '0'.repeat(64),
        generatedAt: '2026-10-19T00:00:00.000Z',
      },
      zooms: [
        {
          id: 's-auto-2000000',
          startUs: asTimestampUs(1 * SECOND),
          durationUs: asDurationUs(2.5 * SECOND),
          poses: [{ timestampUs: asTimestampUs(1.6 * SECOND), anchor: { x: 0.3, y: 0.4 } }],
          easeInUs: 700_000,
          easeOutUs: 700_000,
        },
      ],
    },
  ],
  timeline: {
    id: asTimelineId('timeline'),
    frameRate: { numerator: 60, denominator: 1 },
    tracks: [
      {
        id: asTrackId('video'),
        kind: 'video',
        muted: false,
        clips: [
          {
            id: asClipId('clip'),
            assetId: asAssetId('recording'),
            sourceRange: { startUs: asTimestampUs(0), durationUs: asDurationUs(10 * SECOND) },
            timelineStartUs: asTimestampUs(0),
            effects: [],
          },
        ],
      },
    ],
  },
  settings: {
    defaultFrameRate: { numerator: 60, denominator: 1 },
    previewQuality: 'full',
    colorSpace: 'sdr',
    cursor: DEFAULT_CURSOR_SETTINGS,
    autoZoom: DEFAULT_AUTO_ZOOM_SETTINGS,
    canvas: DEFAULT_CANVAS_STYLE,
  },
};

const context = {
  newClipId: () => asClipId('new-clip'),
  newEffectId: () => asEffectId('new-effect'),
};

describe('auto-zoom overrides', () => {
  it('turns the generated layer off and sets its scale', () => {
    const off = applyProjectCommand(
      project,
      { type: 'set-auto-zoom', enabled: false, scale: 3 },
      context,
    );
    expect(off.ok && off.value.settings.autoZoom).toEqual({
      enabled: false,
      scale: 3,
      disabled: [],
    });
    expect(
      applyProjectCommand(project, { type: 'set-auto-zoom', enabled: true, scale: 2 }, context),
    ).toEqual({ ok: true, value: project });
    expect(
      applyProjectCommand(project, { type: 'set-auto-zoom', enabled: true, scale: 20 }, context),
    ).toEqual({ ok: false, error: 'settings-invalid' });
  });

  it('turns the generated camera toward each action, and keeps the turn when not given', () => {
    const turned = applyProjectCommand(
      project,
      { type: 'set-auto-zoom', enabled: true, scale: 2, turn3d: 0.6 },
      context,
    );
    expect(turned.ok && turned.value.settings.autoZoom.turn3d).toBe(0.6);
    if (!turned.ok) return;
    const deeper = applyProjectCommand(
      turned.value,
      { type: 'set-auto-zoom', enabled: true, scale: 3 },
      context,
    );
    expect(deeper.ok && deeper.value.settings.autoZoom).toMatchObject({ scale: 3, turn3d: 0.6 });
    expect(
      applyProjectCommand(
        turned.value,
        { type: 'set-auto-zoom', enabled: true, scale: 2, turn3d: 0.6 },
        context,
      ),
    ).toEqual({ ok: true, value: turned.value });
    expect(
      applyProjectCommand(
        project,
        { type: 'set-auto-zoom', enabled: true, scale: 2, turn3d: 1.5 },
        context,
      ),
    ).toEqual({ ok: false, error: 'settings-invalid' });
  });

  it('turns one generated zoom off and back on', () => {
    const off = applyProjectCommand(
      project,
      { type: 'set-generated-zoom', zoomId: 's-auto-2000000', enabled: false },
      context,
    );
    expect(off.ok && off.value.settings.autoZoom.disabled).toEqual(['s-auto-2000000']);
    if (!off.ok) return;
    // Already off: nothing changes, so no undo step.
    expect(
      applyProjectCommand(
        off.value,
        { type: 'set-generated-zoom', zoomId: 's-auto-2000000', enabled: false },
        context,
      ),
    ).toEqual({ ok: true, value: off.value });
    const on = applyProjectCommand(
      off.value,
      { type: 'set-generated-zoom', zoomId: 's-auto-2000000', enabled: true },
      context,
    );
    expect(on.ok && on.value.settings.autoZoom.disabled).toEqual([]);
    expect(
      applyProjectCommand(
        project,
        { type: 'set-generated-zoom', zoomId: 'nope', enabled: false },
        context,
      ),
    ).toEqual({ ok: false, error: 'generated-zoom-not-found' });
  });

  it('takes a generated zoom over as the clip’s own, in one step', () => {
    const own: ZoomEffect = {
      id: asEffectId('own'),
      kind: 'zoom',
      range: { startUs: asTimestampUs(1 * SECOND), durationUs: asDurationUs(2.5 * SECOND) },
      enabled: true,
      poses: [
        {
          timestampUs: asTimestampUs(1.6 * SECOND),
          value: { anchor: { x: 0.3, y: 0.4 }, scale: 2 },
          easing: 'ease-in-out',
        },
      ],
      easeInUs: 700_000,
      easeOutUs: 700_000,
      easing: 'ease-in-out',
    };
    const taken = applyProjectCommand(
      project,
      {
        type: 'take-over-generated-zoom',
        zoomId: 's-auto-2000000',
        effects: [{ clipId: asClipId('clip'), effect: own }],
      },
      context,
    );
    expect(taken.ok).toBe(true);
    if (!taken.ok) return;
    expect(taken.value.timeline.tracks[0]?.clips[0]?.effects).toEqual([own]);
    expect(taken.value.settings.autoZoom.disabled).toEqual(['s-auto-2000000']);
    // The generated track itself never changes.
    expect(taken.value.analysisRuns).toBe(project.analysisRuns);

    // An invalid effect changes nothing.
    expect(
      applyProjectCommand(
        project,
        {
          type: 'take-over-generated-zoom',
          zoomId: 's-auto-2000000',
          effects: [{ clipId: asClipId('clip'), effect: { ...own, easeInUs: 3 * SECOND } }],
        },
        context,
      ),
    ).toEqual({ ok: false, error: 'effect-invalid' });
  });

  it('takes over every part of a generated zoom a cut runs through', () => {
    const split = applyProjectCommand(
      project,
      { type: 'split', clipId: asClipId('clip'), atUs: asTimestampUs(2 * SECOND) },
      context,
    );
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    const own = (id: string): ZoomEffect => ({
      id: asEffectId(id),
      kind: 'zoom',
      range: { startUs: asTimestampUs(1 * SECOND), durationUs: asDurationUs(2.5 * SECOND) },
      enabled: true,
      poses: [
        {
          timestampUs: asTimestampUs(1.6 * SECOND),
          value: { anchor: { x: 0.3, y: 0.4 }, scale: 2 },
          easing: 'ease-in-out',
        },
      ],
      easeInUs: 700_000,
      easeOutUs: 700_000,
      easing: 'ease-in-out',
    });
    const taken = applyProjectCommand(
      split.value,
      {
        type: 'take-over-generated-zoom',
        zoomId: 's-auto-2000000',
        effects: [
          { clipId: asClipId('clip'), effect: own('own-a') },
          { clipId: asClipId('new-clip'), effect: own('own-b') },
        ],
      },
      context,
    );
    expect(taken.ok).toBe(true);
    if (!taken.ok) return;
    expect(
      taken.value.timeline.tracks[0]?.clips.map((clip) => clip.effects.map((effect) => effect.id)),
    ).toEqual([['own-a'], ['own-b']]);
    expect(taken.value.settings.autoZoom.disabled).toEqual(['s-auto-2000000']);
  });
});

describe('canvas style', () => {
  const style = {
    aspect: '9:16',
    background: { kind: 'gradient', from: '#101828', to: '#1d2b50', angle: 135 },
    padding: 0.08,
    cornerRadius: 0.1,
    shadow: { opacity: 0.4, blur: 0.05, offsetY: 0.02 },
  } as const;

  it('sets the output canvas, and changes nothing when it is the same', () => {
    const set = applyProjectCommand(project, { type: 'set-canvas', style }, context);
    expect(set.ok && set.value.settings.canvas).toEqual(style);
    if (!set.ok) return;
    expect(applyProjectCommand(set.value, { type: 'set-canvas', style }, context)).toEqual({
      ok: true,
      value: set.value,
    });
  });

  it('refuses a canvas style out of range', () => {
    expect(
      applyProjectCommand(
        project,
        { type: 'set-canvas', style: { ...style, padding: 0.9 } },
        context,
      ),
    ).toEqual({ ok: false, error: 'settings-invalid' });
    expect(
      applyProjectCommand(
        project,
        { type: 'set-canvas', style: { ...style, background: { kind: 'solid', color: 'red' } } },
        context,
      ),
    ).toEqual({ ok: false, error: 'settings-invalid' });
  });
});

describe('cursor look', () => {
  it('changes the cursor’s colour or spotlight alone', () => {
    const cursor = project.settings.cursor;
    const lit = applyProjectCommand(
      project,
      { type: 'set-cursor', settings: { ...cursor, spotlight: 0.5 } },
      context,
    );
    expect(lit.ok && lit.value.settings.cursor.spotlight).toBe(0.5);
    const tinted = applyProjectCommand(
      project,
      { type: 'set-cursor', settings: { ...cursor, color: '#ff3366' } },
      context,
    );
    expect(tinted.ok && tinted.value.settings.cursor.color).toBe('#ff3366');
  });
});
