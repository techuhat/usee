/**
 * A minimal ISO BMFF (MP4) reader for export: it finds a recording's video
 * track and lists its samples, so export can decode them in order with
 * WebCodecs instead of seeking a video element for every frame. It reads
 * what the recorder host writes: one H.264 sample description, sample
 * tables in a `moov`, no fragments and no edit list that moves the picture.
 * Anything else gives `undefined`, and export seeks a video element as before.
 */

/** One coded picture: where it is in the file and when a video element shows it. */
export interface Mp4VideoSample {
  readonly offset: number;
  readonly size: number;
  /** Presentation time, µs: composition time over the media timescale, as Chromium counts it. */
  readonly timestampUs: number;
  readonly durationUs: number;
  readonly isSync: boolean;
}

export interface Mp4VideoTrack {
  /** The WebCodecs codec string, such as `avc1.640028`. */
  readonly codec: string;
  /** The `avcC` record: the decoder configuration WebCodecs takes as `description`. */
  readonly description: Uint8Array;
  readonly codedWidth: number;
  readonly codedHeight: number;
  /** In decode order. */
  readonly samples: readonly Mp4VideoSample[];
}

/** Reads `length` bytes at `offset`; fewer at the end of the file. */
export type ReadBytes = (offset: number, length: number) => Promise<Uint8Array>;

/** A `moov` larger than this is not a recording's: a day at 60 fps needs far less. */
const MAX_MOOV_BYTES = 64 * 1024 * 1024;
const MAX_TOP_LEVEL_BOXES = 256;
const MAX_SAMPLES = 10_000_000;

class Malformed extends Error {}

interface Box {
  readonly type: string;
  /** Where its contents start and end, within the bytes it was read from. */
  readonly start: number;
  readonly end: number;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function fourCc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(
    bytes[at] ?? 0,
    bytes[at + 1] ?? 0,
    bytes[at + 2] ?? 0,
    bytes[at + 3] ?? 0,
  );
}

class Reader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = view(bytes);
  }

  #check(at: number, length: number): void {
    if (!Number.isSafeInteger(at) || at < 0 || at + length > this.#bytes.byteLength) {
      throw new Malformed('read past the end');
    }
  }

  u8(at: number): number {
    this.#check(at, 1);
    return this.#view.getUint8(at);
  }

  u16(at: number): number {
    this.#check(at, 2);
    return this.#view.getUint16(at);
  }

  u32(at: number): number {
    this.#check(at, 4);
    return this.#view.getUint32(at);
  }

  i32(at: number): number {
    this.#check(at, 4);
    return this.#view.getInt32(at);
  }

  u64(at: number): number {
    this.#check(at, 8);
    const value = this.#view.getBigUint64(at);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Malformed('a 64-bit value too large');
    }
    return Number(value);
  }

  slice(start: number, end: number): Uint8Array {
    this.#check(start, end - start);
    return this.#bytes.slice(start, end);
  }

  type(at: number): string {
    this.#check(at, 4);
    return fourCc(this.#bytes, at);
  }

  /** The boxes between `start` and `end`. */
  boxes(start: number, end: number): Box[] {
    const found: Box[] = [];
    let at = start;
    while (at < end) {
      let size = this.u32(at);
      const type = this.type(at + 4);
      let header = 8;
      if (size === 1) {
        size = this.u64(at + 8);
        header = 16;
      } else if (size === 0) {
        size = end - at;
      }
      if (size < header || at + size > end) {
        throw new Malformed(`box ${type} overruns its parent`);
      }
      found.push({ type, start: at + header, end: at + size });
      at += size;
    }
    return found;
  }

  child(parent: Box, type: string): Box | undefined {
    return this.boxes(parent.start, parent.end).find((box) => box.type === type);
  }

  require(parent: Box, type: string): Box {
    const box = this.child(parent, type);
    if (box === undefined) {
      throw new Malformed(`no ${type} box`);
    }
    return box;
  }
}

/**
 * The `moov` box, found by walking the file's top-level boxes; a recording
 * writes it after its media. Undefined for a fragmented file or one without.
 */
export async function readMoov(read: ReadBytes): Promise<Uint8Array | undefined> {
  let offset = 0;
  for (let index = 0; index < MAX_TOP_LEVEL_BOXES; index += 1) {
    const header = await read(offset, 16);
    if (header.byteLength < 8) {
      return undefined;
    }
    let size = view(header).getUint32(0);
    const type = fourCc(header, 4);
    if (size === 1) {
      if (header.byteLength < 16) {
        return undefined;
      }
      const large = view(header).getBigUint64(8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) {
        return undefined;
      }
      size = Number(large);
    }
    if (size < 8 || type === 'moof') {
      // A box to the end of the file, a broken size, or fragments: not a recording's layout.
      return undefined;
    }
    if (type === 'moov') {
      if (size > MAX_MOOV_BYTES) {
        return undefined;
      }
      const moov = await read(offset, size);
      return moov.byteLength === size ? moov : undefined;
    }
    offset += size;
  }
  return undefined;
}

const hex = (value: number) => value.toString(16).padStart(2, '0');

/** Expands run-length `(count, value)` pairs, refusing more entries than `limit`. */
function expandRuns(
  reader: Reader,
  box: Box,
  limit: number,
  value: (at: number) => number,
): number[] {
  const count = reader.u32(box.start + 4);
  const values: number[] = [];
  for (let entry = 0; entry < count; entry += 1) {
    const at = box.start + 8 + entry * 8;
    const runLength = reader.u32(at);
    if (values.length + runLength > limit) {
      throw new Malformed('a table longer than its samples');
    }
    const runValue = value(at + 4);
    for (let index = 0; index < runLength; index += 1) {
      values.push(runValue);
    }
  }
  return values;
}

function parseTrack(reader: Reader, trak: Box): Mp4VideoTrack | undefined {
  const edts = reader.child(trak, 'edts');
  if (edts !== undefined) {
    // An edit list moves or cuts the picture: only the identity edit is read here.
    const elst = reader.require(edts, 'elst');
    const version = reader.u8(elst.start);
    const entries = reader.u32(elst.start + 4);
    const mediaTime =
      version === 1
        ? Number(view(reader.slice(elst.start + 16, elst.start + 24)).getBigInt64(0))
        : reader.i32(elst.start + 12);
    const rate = reader.u32(elst.start + (version === 1 ? 24 : 16));
    if (entries !== 1 || mediaTime !== 0 || rate !== 0x0001_0000) {
      return undefined;
    }
  }
  const mdia = reader.require(trak, 'mdia');
  const mdhd = reader.require(mdia, 'mdhd');
  const timescale = reader.u32(mdhd.start + (reader.u8(mdhd.start) === 1 ? 20 : 12));
  if (timescale === 0) {
    throw new Malformed('no timescale');
  }
  const stbl = reader.require(reader.require(mdia, 'minf'), 'stbl');

  const stsd = reader.require(stbl, 'stsd');
  const entry = reader.boxes(stsd.start + 8, stsd.end)[0];
  if (entry === undefined || (entry.type !== 'avc1' && entry.type !== 'avc3')) {
    return undefined;
  }
  // VisualSampleEntry: 6 reserved, 2 data reference, 16 predefined, then width and height.
  const codedWidth = reader.u16(entry.start + 24);
  const codedHeight = reader.u16(entry.start + 26);
  const avcC = reader.boxes(entry.start + 78, entry.end).find((box) => box.type === 'avcC');
  if (avcC === undefined || avcC.end - avcC.start < 4) {
    return undefined;
  }
  const description = reader.slice(avcC.start, avcC.end);
  const codec = `avc1.${hex(description[1] ?? 0)}${hex(description[2] ?? 0)}${hex(description[3] ?? 0)}`;

  if (reader.child(stbl, 'stz2') !== undefined) {
    return undefined;
  }
  const stsz = reader.require(stbl, 'stsz');
  const uniformSize = reader.u32(stsz.start + 4);
  const count = reader.u32(stsz.start + 8);
  if (count === 0 || count > MAX_SAMPLES) {
    throw new Malformed('no samples, or too many');
  }
  const sizes = Array.from({ length: count }, (_, index) =>
    uniformSize !== 0 ? uniformSize : reader.u32(stsz.start + 12 + index * 4),
  );

  const deltas = expandRuns(reader, reader.require(stbl, 'stts'), count, (at) => reader.u32(at));
  if (deltas.length !== count) {
    throw new Malformed('stts does not cover every sample');
  }
  const ctts = reader.child(stbl, 'ctts');
  const offsets =
    ctts === undefined
      ? new Array<number>(count).fill(0)
      : expandRuns(reader, ctts, count, (at) =>
          reader.u8(ctts.start) === 1 ? reader.i32(at) : reader.u32(at),
        );
  if (offsets.length !== count) {
    throw new Malformed('ctts does not cover every sample');
  }

  const stss = reader.child(stbl, 'stss');
  const sync = new Set<number>();
  if (stss !== undefined) {
    const entries = reader.u32(stss.start + 4);
    for (let index = 0; index < entries; index += 1) {
      sync.add(reader.u32(stss.start + 8 + index * 4) - 1);
    }
  }

  const stco = reader.child(stbl, 'stco');
  const co64 = reader.child(stbl, 'co64');
  const chunkTable = stco ?? co64;
  if (chunkTable === undefined) {
    throw new Malformed('no chunk offsets');
  }
  const chunkCount = reader.u32(chunkTable.start + 4);
  const chunkOffset = (chunk: number) =>
    stco !== undefined
      ? reader.u32(chunkTable.start + 8 + chunk * 4)
      : reader.u64(chunkTable.start + 8 + chunk * 8);
  const stsc = reader.require(stbl, 'stsc');
  const runs = reader.u32(stsc.start + 4);

  const samples: Mp4VideoSample[] = [];
  const toUs = (ticks: number) => Math.round((ticks * 1_000_000) / timescale);
  let decodeTime = 0;
  let sample = 0;
  for (let run = 0; run < runs; run += 1) {
    const firstChunk = reader.u32(stsc.start + 8 + run * 12) - 1;
    const perChunk = reader.u32(stsc.start + 12 + run * 12);
    const nextFirst = run + 1 < runs ? reader.u32(stsc.start + 8 + (run + 1) * 12) - 1 : chunkCount;
    if (firstChunk < 0 || nextFirst < firstChunk || nextFirst > chunkCount) {
      throw new Malformed('stsc runs out of order');
    }
    for (let chunk = firstChunk; chunk < nextFirst; chunk += 1) {
      let at = chunkOffset(chunk);
      for (let inChunk = 0; inChunk < perChunk && sample < count; inChunk += 1) {
        const size = sizes[sample] ?? 0;
        const delta = deltas[sample] ?? 0;
        samples.push({
          offset: at,
          size,
          timestampUs: toUs(decodeTime + (offsets[sample] ?? 0)),
          durationUs: toUs(delta),
          isSync: stss === undefined || sync.has(sample),
        });
        at += size;
        decodeTime += delta;
        sample += 1;
      }
    }
  }
  if (samples.length !== count) {
    throw new Malformed('the chunks do not hold every sample');
  }
  return { codec, description, codedWidth, codedHeight, samples };
}

/** The first video track in a `moov`, or undefined when export cannot decode it in order. */
export function parseVideoTrack(moov: Uint8Array): Mp4VideoTrack | undefined {
  try {
    const reader = new Reader(moov);
    const [root] = reader.boxes(0, moov.byteLength);
    if (root?.type !== 'moov' || reader.child(root, 'mvex') !== undefined) {
      return undefined;
    }
    for (const trak of reader.boxes(root.start, root.end).filter((box) => box.type === 'trak')) {
      const hdlr = reader.child(reader.require(trak, 'mdia'), 'hdlr');
      if (hdlr !== undefined && reader.type(hdlr.start + 8) === 'vide') {
        return parseTrack(reader, trak);
      }
    }
    return undefined;
  } catch (error) {
    if (error instanceof Malformed) {
      return undefined;
    }
    throw error;
  }
}

/** Two microseconds: the plan's times are truncated to µs and the samples' rounded. */
const TIME_TOLERANCE_US = 2;

/**
 * The sample a video element shows at `sourceUs`: the last one to start at or
 * before it, or the first when it is earlier than any. `byTime` lists the
 * samples' indices in presentation order.
 */
export function sampleAt(
  samples: readonly Mp4VideoSample[],
  byTime: readonly number[],
  sourceUs: number,
): number {
  let low = 0;
  let high = byTime.length - 1;
  let found = byTime[0] ?? 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const index = byTime[middle] ?? 0;
    if ((samples[index]?.timestampUs ?? Infinity) <= sourceUs + TIME_TOLERANCE_US) {
      found = index;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/** The sync sample a decoder must start from to reach `index`, in decode order. */
export function syncSampleBefore(samples: readonly Mp4VideoSample[], index: number): number {
  for (let candidate = index; candidate > 0; candidate -= 1) {
    if (samples[candidate]?.isSync === true) {
      return candidate;
    }
  }
  return 0;
}

/** The samples' indices in presentation order. */
export function presentationOrder(samples: readonly Mp4VideoSample[]): number[] {
  return samples
    .map((_, index) => index)
    .sort(
      (first, second) => (samples[first]?.timestampUs ?? 0) - (samples[second]?.timestampUs ?? 0),
    );
}
