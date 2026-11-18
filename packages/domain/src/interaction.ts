import type { CursorShape, PointerButton, TimestampUs } from '@usee/contracts';

export { CURSOR_SHAPES, POINTER_BUTTONS } from '@usee/contracts';
export type { CursorShape, PointerButton } from '@usee/contracts';

/**
 * One raw pointer observation, at session time. Positions are normalized to
 * the captured display (0-1) and can fall outside it. The raw stream is
 * immutable; smoothed paths and click effects are derived from it and can
 * always be regenerated.
 */
export type PointerEvent =
  | { readonly type: 'move'; readonly timeUs: TimestampUs; readonly x: number; readonly y: number }
  | {
      readonly type: 'down' | 'up';
      readonly timeUs: TimestampUs;
      readonly x: number;
      readonly y: number;
      readonly button: PointerButton;
    }
  | { readonly type: 'shape'; readonly timeUs: TimestampUs; readonly shape: CursorShape }
  | { readonly type: 'visibility'; readonly timeUs: TimestampUs; readonly visible: boolean };

/** A session's pointer recording: the display it was measured on, then its events in time order. */
export interface PointerStream {
  readonly coordinateSpace: 'capture';
  readonly display: { readonly width: number; readonly height: number; readonly dpiScale: number };
  readonly events: readonly PointerEvent[];
}
