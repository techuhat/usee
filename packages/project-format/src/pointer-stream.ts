import { z } from 'zod';

import { asTimestampUs, err, ok, type Result } from '@usee/contracts';
import {
  CURSOR_SHAPES,
  POINTER_BUTTONS,
  type CursorShape,
  type PointerEvent,
  type PointerStream,
} from '@usee/domain';

/** Bundle-relative path of a session's pointer stream (an `event` asset, `jsonl`). */
export function pointerStreamPath(sessionId: string): string {
  return `metadata/interactions/${sessionId}.pointer.ndjson`;
}

const headerSchema = z.object({
  // Recordings made before 2026-11-18, under the working title, say `screen-studio.pointer`.
  format: z.enum(['usee.pointer', 'screen-studio.pointer']),
  version: z.literal(1),
  coordinateSpace: z.literal('capture'),
  display: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    dpiScale: z.number().positive().max(16),
  }),
});

const time = z.number().int().nonnegative();
// Off-display positions are kept; anything this far out is damage.
const coordinate = z.number().min(-100).max(100);
const button = z.enum(POINTER_BUTTONS);
const shapes: ReadonlySet<string> = new Set(CURSOR_SHAPES);

const eventSchema = z.discriminatedUnion('type', [
  z.object({ t: time, type: z.literal('move'), x: coordinate, y: coordinate }),
  z.object({ t: time, type: z.literal('down'), button, x: coordinate, y: coordinate }),
  z.object({ t: time, type: z.literal('up'), button, x: coordinate, y: coordinate }),
  z.object({ t: time, type: z.literal('shape'), shape: z.string().max(32) }),
  z.object({ t: time, type: z.literal('visibility'), visible: z.boolean() }),
]);

export interface DecodedPointerStream {
  readonly stream: PointerStream;
  /** Lines that were not a valid event, such as a last line cut off by a crash. */
  readonly skippedLines: number;
}

function toEvent(raw: z.output<typeof eventSchema>): PointerEvent {
  const timeUs = asTimestampUs(raw.t);
  switch (raw.type) {
    case 'move':
      return { type: 'move', timeUs, x: raw.x, y: raw.y };
    case 'down':
    case 'up':
      return { type: raw.type, timeUs, x: raw.x, y: raw.y, button: raw.button };
    case 'shape':
      // A kind a newer host knows draws as the arrow.
      return {
        type: 'shape',
        timeUs,
        shape: shapes.has(raw.shape) ? (raw.shape as CursorShape) : 'arrow',
      };
    case 'visibility':
      return { type: 'visibility', timeUs, visible: raw.visible };
  }
}

/**
 * Reads a pointer stream (`pointer.ndjson`, docs/recorder-host-protocol.md).
 * The header must be valid. Event lines that are not are skipped and
 * counted, and the events come back in time order.
 */
export function decodePointerStream(text: string): Result<DecodedPointerStream, string> {
  const lines = text.split('\n');
  let header: z.output<typeof headerSchema>;
  try {
    const parsed = headerSchema.safeParse(JSON.parse(lines[0] ?? ''));
    if (!parsed.success) {
      return err(parsed.error.issues[0]?.message ?? 'invalid pointer header');
    }
    header = parsed.data;
  } catch {
    return err('pointer header is not valid JSON');
  }

  const events: PointerEvent[] = [];
  let skippedLines = 0;
  for (const line of lines.slice(1)) {
    if (line.trim() === '') {
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      skippedLines += 1;
      continue;
    }
    const parsed = eventSchema.safeParse(raw);
    if (parsed.success) {
      events.push(toEvent(parsed.data));
    } else {
      skippedLines += 1;
    }
  }
  events.sort((a, b) => a.timeUs - b.timeUs);
  return ok({
    stream: { coordinateSpace: header.coordinateSpace, display: header.display, events },
    skippedLines,
  });
}
