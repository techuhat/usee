/** Minimal ISO-BMFF reader: enough to prove a file was finalized and read its tracks. */

interface Box {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly headerSize: number;
}

function* boxes(buffer: Buffer, start: number, end: number): Generator<Box> {
  let offset = start;
  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      size = Number(buffer.readBigUInt64BE(offset + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) {
      return;
    }
    yield { type, start: offset, end: offset + size, headerSize };
    offset += size;
  }
}

function child(buffer: Buffer, parent: Box | undefined, type: string): Box | undefined {
  if (parent === undefined) {
    return undefined;
  }
  return [...boxes(buffer, parent.start + parent.headerSize, parent.end)].find(
    (box) => box.type === type,
  );
}

/** `mvhd` and `mdhd` share their timing layout after the version byte. */
function durationOf(buffer: Buffer, box: Box | undefined): number | undefined {
  if (box === undefined) {
    return undefined;
  }
  const body = box.start + box.headerSize;
  const version = buffer.readUInt8(body);
  const timescale = buffer.readUInt32BE(body + (version === 1 ? 20 : 12));
  const duration =
    version === 1 ? Number(buffer.readBigUInt64BE(body + 24)) : buffer.readUInt32BE(body + 16);
  return duration / timescale;
}

export interface Mp4Track {
  /** `hdlr` handler type: `vide` or `soun`. */
  readonly handler: string;
  readonly durationSeconds: number | undefined;
}

export interface Mp4Summary {
  readonly topLevelBoxes: readonly string[];
  /** From `moov/mvhd`; undefined when the file was never finalized. */
  readonly durationSeconds: number | undefined;
  readonly tracks: readonly Mp4Track[];
}

export function readMp4(buffer: Buffer): Mp4Summary {
  const topLevel = [...boxes(buffer, 0, buffer.length)];
  const moov = topLevel.find((box) => box.type === 'moov');
  const tracks: Mp4Track[] = [];
  if (moov !== undefined) {
    for (const trak of boxes(buffer, moov.start + moov.headerSize, moov.end)) {
      if (trak.type !== 'trak') {
        continue;
      }
      const mdia = child(buffer, trak, 'mdia');
      const hdlr = child(buffer, mdia, 'hdlr');
      const handlerOffset = hdlr === undefined ? undefined : hdlr.start + hdlr.headerSize + 8;
      tracks.push({
        handler:
          handlerOffset === undefined
            ? ''
            : buffer.toString('latin1', handlerOffset, handlerOffset + 4),
        durationSeconds: durationOf(buffer, child(buffer, mdia, 'mdhd')),
      });
    }
  }
  return {
    topLevelBoxes: topLevel.map((box) => box.type),
    durationSeconds: durationOf(buffer, child(buffer, moov, 'mvhd')),
    tracks,
  };
}
