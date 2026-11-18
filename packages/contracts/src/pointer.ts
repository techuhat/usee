import { z } from 'zod';

export const POINTER_BUTTONS = ['left', 'right', 'middle', 'x1', 'x2'] as const;
export type PointerButton = (typeof POINTER_BUTTONS)[number];

/** Standard cursor kinds; a cursor an application drew itself is recorded as `arrow`. */
export const CURSOR_SHAPES = [
  'arrow',
  'text',
  'pointer',
  'wait',
  'progress',
  'crosshair',
  'ew-resize',
  'ns-resize',
  'nwse-resize',
  'nesw-resize',
  'move',
  'not-allowed',
  'help',
] as const;
export type CursorShape = (typeof CURSOR_SHAPES)[number];

const time = z.number().nonnegative().max(Number.MAX_SAFE_INTEGER);
const coordinate = z.number().min(-100).max(100);
// About 24 MB of samples, a few hours of continuous movement.
const packed = z
  .string()
  .max(32 * 1024 * 1024)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/);

/**
 * A recording session's pointer stream for the editor, in columns: move
 * times as little-endian Float64 microseconds and positions as Float32, each
 * base64-encoded; clicks, shapes and visibility as short lists.
 */
export const pointerTrackSchema = z
  .object({
    display: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        dpiScale: z.number().positive().max(16),
      })
      .readonly(),
    moveTimes: packed,
    moveXs: packed,
    moveYs: packed,
    clicks: z
      .array(
        z
          .object({ timeUs: time, x: coordinate, y: coordinate, button: z.enum(POINTER_BUTTONS) })
          .readonly(),
      )
      .max(500_000)
      .readonly(),
    shapes: z
      .array(z.object({ timeUs: time, shape: z.enum(CURSOR_SHAPES) }).readonly())
      .max(500_000)
      .readonly(),
    visibility: z
      .array(z.object({ timeUs: time, visible: z.boolean() }).readonly())
      .max(500_000)
      .readonly(),
  })
  .readonly();
export type PointerTrackDto = z.output<typeof pointerTrackSchema>;
