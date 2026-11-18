import { describe, expect, it } from 'vitest';

import { asDurationUs, asEffectId, asTimestampUs } from '@usee/contracts';

import { FULL_FRAME } from './camera-view';
import { deriveCursorPath, pointerTrackFromStream } from './cursor-path';
import { DEFAULT_CURSOR_SETTINGS, type Effect, type ZoomEffect } from './effects';
import {
  composeFrame,
  CURSOR_BOX_PX,
  pointerTimeOrigin,
  type CursorSource,
} from './frame-composition';
import type { PointerEvent } from './interaction';

const SECOND = 1_000_000;
const at = (seconds: number) => asTimestampUs(Math.round(seconds * SECOND));
const range = (start: number, duration: number) => ({
  startUs: at(start),
  durationUs: asDurationUs(Math.round(duration * SECOND)),
});

const effects: readonly Effect[] = [
  {
    id: asEffectId('zoom'),
    kind: 'zoom',
    range: range(1, 2),
    enabled: true,
    poses: [
      { timestampUs: at(1), value: { anchor: { x: 0.75, y: 0.5 }, scale: 2 }, easing: 'linear' },
    ],
    easeInUs: 500_000,
    easeOutUs: 500_000,
    easing: 'linear',
  },
  {
    id: asEffectId('blur'),
    kind: 'blur',
    range: range(0.5, 1.5),
    enabled: true,
    intensity: 0.05,
    regions: [
      {
        timestampUs: at(0.5),
        value: [{ kind: 'rectangle', bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } }],
        easing: 'linear',
      },
    ],
  },
];

// The pointer crosses the frame over four seconds of its session and clicks at 2 s;
// the clip's media starts one second into the session.
const events: PointerEvent[] = [
  { type: 'move', timeUs: at(0), x: 0.2, y: 0.2 },
  { type: 'down', timeUs: at(2), x: 0.5, y: 0.5, button: 'left' },
  { type: 'move', timeUs: at(4), x: 0.8, y: 0.8 },
];
const path = deriveCursorPath(
  pointerTrackFromStream({
    coordinateSpace: 'capture',
    display: { width: 1920, height: 1080, dpiScale: 1.5 },
    events,
  }),
  0,
);
const pointer: CursorSource = {
  path,
  sessionStartUs: SECOND,
  settings: { ...DEFAULT_CURSOR_SETTINGS, size: 2 },
};

describe('frame composition', () => {
  it('composes a clip’s frame at named moments', () => {
    const early = composeFrame(effects, 0.25 * SECOND, pointer);
    expect(early.camera).toEqual(FULL_FRAME);
    expect(early.blurs).toEqual([]);
    // Session time 1.25 s: 0.2 + 0.6 * 1.25 / 4.
    expect(early.cursor?.x).toBeCloseTo(0.3875, 4);
    expect(early.cursor?.shape).toBe('arrow');
    expect(early.clicks).toEqual([]);

    const clicking = composeFrame(effects, 1 * SECOND, pointer);
    expect(clicking.camera).toEqual(FULL_FRAME); // the zoom is only starting
    expect(clicking.blurs).toHaveLength(1);
    expect(clicking.clicks).toHaveLength(1);
    expect(clicking.clicks[0]?.progress).toBe(0);
    expect(clicking.clicks[0]?.x).toBeCloseTo(0.5, 4);
    expect(clicking.clickEffect).toBe('ripple');

    const zoomed = composeFrame(effects, 2 * SECOND, pointer);
    expect(zoomed.camera.scale).toBeCloseTo(2, 6);
    expect(zoomed.camera.centerX).toBeCloseTo(0.75, 6);
    expect(zoomed.blurs).toEqual([]);
    expect(zoomed.cursor?.x).toBeCloseTo(0.65, 4);
  });

  it('sizes the cursor from the display it was recorded on', () => {
    const frame = composeFrame([], 0, pointer);
    expect(frame.cursorHeight).toBeCloseTo((CURSOR_BOX_PX * 1.5 * 2) / 1080, 9);
  });

  it('hides the cursor as set or as recorded, and the click effects as set', () => {
    const hidden = composeFrame([], 1 * SECOND, {
      ...pointer,
      settings: { ...pointer.settings, visible: false },
    });
    expect(hidden.cursor).toBeUndefined();
    expect(hidden.clicks).toHaveLength(1);

    const quiet = composeFrame([], 1 * SECOND, {
      ...pointer,
      settings: { ...pointer.settings, clickEffect: 'none' },
    });
    expect(quiet.cursor).toBeDefined();
    expect(quiet.clicks).toEqual([]);
    const bouncing = composeFrame([], 1 * SECOND, {
      ...pointer,
      settings: { ...pointer.settings, clickEffect: 'bounce' },
    });
    expect(bouncing).toMatchObject({ clickEffect: 'bounce', clicks: [{ progress: 0 }] });

    const recordedHidden = deriveCursorPath(
      pointerTrackFromStream({
        coordinateSpace: 'capture',
        display: { width: 1920, height: 1080, dpiScale: 1 },
        events: [...events, { type: 'visibility', timeUs: at(1.5), visible: false }],
      }),
      0,
    );
    expect(
      composeFrame([], 1 * SECOND, { ...pointer, path: recordedHidden }).cursor,
    ).toBeUndefined();
  });

  it('reads the pointer as much earlier as the picture is older than its timestamp', () => {
    // Media time 0 is one second into the session; each picture is 50 ms older than its time.
    const origin = pointerTimeOrigin({ sessionStartUs: SECOND, captureLatencyUs: 50_000 });
    expect(origin).toBe(950_000);
    expect(pointerTimeOrigin({ sessionStartUs: SECOND })).toBe(SECOND);
    // A picture shown 20 ms after its timestamp: the pointer is read 20 ms later.
    expect(pointerTimeOrigin({ sessionStartUs: SECOND, captureLatencyUs: -20_000 })).toBe(
      1_020_000,
    );
    // At media time 1 s the picture shows session time 1.95 s, so the cursor is where it was then.
    expect(composeFrame([], SECOND, pointer).cursor?.x).toBeCloseTo(0.5, 4);
    expect(composeFrame([], SECOND, { ...pointer, sessionStartUs: origin }).cursor?.x).toBeCloseTo(
      0.4925,
      4,
    );
  });

  it('keeps the pointer in view of the generated camera, but not of a zoom of the clip’s own', () => {
    // A generated zoom holding on the top left for the first three seconds of the media.
    const generated: ZoomEffect = {
      id: asEffectId('auto'),
      kind: 'zoom',
      range: range(0, 3),
      enabled: true,
      poses: [
        { timestampUs: at(0), value: { anchor: { x: 0.25, y: 0.25 }, scale: 2 }, easing: 'linear' },
      ],
      easeInUs: 0,
      easeOutUs: 0,
      easing: 'linear',
    };
    // Two seconds into the media, three into the session, the pointer is at 0.65.
    expect(composeFrame([], 2 * SECOND, undefined, [generated]).camera).toMatchObject({
      centerX: 0.25,
      centerY: 0.25,
    });
    const followed = composeFrame([], 2 * SECOND, pointer, [generated]).camera;
    expect(followed.centerX).toBeCloseTo(0.5, 3);
    expect(followed.centerY).toBeCloseTo(0.5, 3);
    // The clip's own zoom holds where it was put.
    expect(
      composeFrame([{ ...generated, id: asEffectId('own') }], 2 * SECOND, pointer).camera,
    ).toMatchObject({
      centerX: 0.25,
      centerY: 0.25,
    });
  });

  it('has no cursor without a recorded pointer', () => {
    expect(composeFrame(effects, 2 * SECOND)).toMatchObject({
      cursor: undefined,
      clicks: [],
      clickEffect: 'none',
      cursorHeight: 0,
    });
  });
});

describe('cursor colour, spotlight and camera motion', () => {
  it('draws the cursor in its colour, white unless set, with the spotlight as set', () => {
    const plain = composeFrame([], 0.5 * SECOND, pointer);
    expect(plain.cursorColor).toBe('#ffffff');
    expect(plain.spotlight).toBe(0);
    const styled = composeFrame([], 0.5 * SECOND, {
      ...pointer,
      settings: { ...pointer.settings, color: '#ff3366', spotlight: 0.6 },
    });
    expect(styled.cursorColor).toBe('#ff3366');
    expect(styled.spotlight).toBe(0.6);
  });

  it('knows how fast the camera moves: still outside a zoom, moving while it eases in', () => {
    expect(composeFrame(effects, 0.25 * SECOND, pointer).cameraMotion).toBe(0);
    expect(composeFrame(effects, 2 * SECOND, pointer).cameraMotion).toBe(0);
    expect(composeFrame(effects, 1.25 * SECOND, pointer).cameraMotion).toBeGreaterThan(0.1);
  });

  it('counts a turn as motion, so a 3D move blurs too', () => {
    const turning: ZoomEffect = {
      id: asEffectId('turning'),
      kind: 'zoom',
      range: { startUs: asTimestampUs(0), durationUs: asDurationUs(4 * SECOND) },
      enabled: true,
      poses: [
        {
          timestampUs: asTimestampUs(0),
          value: { anchor: { x: 0.5, y: 0.5 }, scale: 1, rotation: { x: 0, y: -20, z: 0 } },
          easing: 'linear',
        },
        {
          timestampUs: asTimestampUs(2 * SECOND),
          value: { anchor: { x: 0.5, y: 0.5 }, scale: 1, rotation: { x: 0, y: 20, z: 0 } },
          easing: 'linear',
        },
      ],
      easeInUs: 0,
      easeOutUs: 0,
      easing: 'linear',
    };
    // Scale and centre stay put; only the turn moves, 40 degrees over two seconds.
    expect(composeFrame([turning], SECOND).cameraMotion).toBeCloseTo((20 * Math.PI) / 180, 2);
    expect(composeFrame([turning], 3 * SECOND).cameraMotion).toBe(0);
  });
});
