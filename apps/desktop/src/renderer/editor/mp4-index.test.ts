import { describe, expect, it } from 'vitest';

import {
  parseVideoTrack,
  presentationOrder,
  readMoov,
  sampleAt,
  syncSampleBefore,
  type Mp4VideoSample,
} from './mp4-index';

const u8 = (...values: number[]) => Uint8Array.from(values);
const u16 = (value: number) => u8(value >> 8, value & 0xff);
const u32 = (value: number) =>
  u8((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
const u64 = (value: number) => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
};
const i32 = (value: number) => u32(value >>> 0);
const ascii = (text: string) => Uint8Array.from(text, (character) => character.charCodeAt(0));

function concat(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return bytes;
}

const box = (type: string, ...body: Uint8Array[]) => {
  const content = concat(...body);
  return concat(u32(content.byteLength + 8), ascii(type), content);
};
const fullBox = (type: string, version: number, ...body: Uint8Array[]) =>
  box(type, u8(version, 0, 0, 0), ...body);

/** High profile 4.0 with the constraint byte 0x04: `avc1.640428`. */
const AVCC = u8(1, 0x64, 0x04, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0x00, 0x28, 1, 0, 2, 0x68, 0xee);

function avc1(type = 'avc1', width = 1920, height = 1080): Uint8Array {
  return box(
    type,
    new Uint8Array(6),
    u16(1),
    new Uint8Array(16),
    u16(width),
    u16(height),
    u32(0x00480000),
    u32(0x00480000),
    u32(0),
    u16(1),
    new Uint8Array(32),
    u16(0x18),
    u16(0xffff),
    box('avcC', AVCC),
  );
}

interface TrackOptions {
  readonly sampleEntry?: Uint8Array;
  readonly sizes?: readonly number[];
  /** `(count, delta)` runs. */
  readonly stts?: readonly (readonly [number, number])[];
  /** `(count, offset)` runs; version 1 when any offset is negative. */
  readonly ctts?: readonly (readonly [number, number])[];
  /** 1-based sync sample numbers; every sample is sync without. */
  readonly stss?: readonly number[];
  /** `(firstChunk, samplesPerChunk)` runs. */
  readonly stsc?: readonly (readonly [number, number])[];
  readonly chunkOffsets?: readonly number[];
  readonly co64?: boolean;
  readonly elst?: Uint8Array;
  readonly timescale?: number;
  readonly extraStbl?: Uint8Array;
}

function videoTrak(options: TrackOptions = {}): Uint8Array {
  const sizes = options.sizes ?? [100, 50, 60, 70];
  const stts = options.stts ?? [[sizes.length, 1000]];
  const stsc = options.stsc ?? [[1, 2]];
  const chunkOffsets = options.chunkOffsets ?? [1000, 2000];
  const tables = [
    fullBox('stsd', 0, u32(1), options.sampleEntry ?? avc1()),
    fullBox(
      'stts',
      0,
      u32(stts.length),
      ...stts.flatMap(([count, delta]) => [u32(count), u32(delta)]),
    ),
    ...(options.ctts === undefined
      ? []
      : [
          fullBox(
            'ctts',
            options.ctts.some(([, offset]) => offset < 0) ? 1 : 0,
            u32(options.ctts.length),
            ...options.ctts.flatMap(([count, offset]) => [u32(count), i32(offset)]),
          ),
        ]),
    ...(options.stss === undefined
      ? []
      : [fullBox('stss', 0, u32(options.stss.length), ...options.stss.map(u32))]),
    fullBox('stsz', 0, u32(0), u32(sizes.length), ...sizes.map(u32)),
    fullBox(
      'stsc',
      0,
      u32(stsc.length),
      ...stsc.flatMap(([first, per]) => [u32(first), u32(per), u32(1)]),
    ),
    options.co64 === true
      ? fullBox('co64', 0, u32(chunkOffsets.length), ...chunkOffsets.map(u64))
      : fullBox('stco', 0, u32(chunkOffsets.length), ...chunkOffsets.map(u32)),
    ...(options.extraStbl === undefined ? [] : [options.extraStbl]),
  ];
  return box(
    'trak',
    fullBox('tkhd', 0, new Uint8Array(80)),
    ...(options.elst === undefined ? [] : [box('edts', options.elst)]),
    box(
      'mdia',
      fullBox(
        'mdhd',
        0,
        u32(0),
        u32(0),
        u32(options.timescale ?? 60_000),
        u32(0),
        new Uint8Array(4),
      ),
      fullBox('hdlr', 0, u32(0), ascii('vide'), new Uint8Array(12), u8(0)),
      box('minf', box('stbl', ...tables)),
    ),
  );
}

const soundTrak = box(
  'trak',
  box('mdia', fullBox('hdlr', 0, u32(0), ascii('soun'), new Uint8Array(12), u8(0))),
);

const moov = (...children: Uint8Array[]) =>
  box('moov', fullBox('mvhd', 0, new Uint8Array(96)), ...children);

describe('the MP4 index', () => {
  it('lists the video track’s samples: where each is, when it shows and which are keyframes', () => {
    const track = parseVideoTrack(
      moov(
        soundTrak,
        videoTrak({
          sizes: [100, 50, 60, 70, 80],
          // Constant composition offset, as the recorder host writes: 4 frames late.
          ctts: [[5, 4000]],
          stss: [1, 4],
          stsc: [
            [1, 2],
            [2, 3],
          ],
          chunkOffsets: [1000, 5000],
        }),
      ),
    );
    expect(track).toBeDefined();
    if (track === undefined) return;
    expect(track.codec).toBe('avc1.640428');
    expect(track.description).toEqual(AVCC);
    expect([track.codedWidth, track.codedHeight]).toEqual([1920, 1080]);
    expect(track.samples).toEqual([
      { offset: 1000, size: 100, timestampUs: 66_667, durationUs: 16_667, isSync: true },
      { offset: 1100, size: 50, timestampUs: 83_333, durationUs: 16_667, isSync: false },
      { offset: 5000, size: 60, timestampUs: 100_000, durationUs: 16_667, isSync: false },
      { offset: 5060, size: 70, timestampUs: 116_667, durationUs: 16_667, isSync: true },
      { offset: 5130, size: 80, timestampUs: 133_333, durationUs: 16_667, isSync: false },
    ]);
  });

  it('reads 64-bit chunk offsets and signed composition offsets', () => {
    const track = parseVideoTrack(
      moov(
        videoTrak({
          sizes: [10, 10, 10],
          stts: [[3, 3000]],
          ctts: [
            [1, 0],
            [1, 6000],
            [1, -3000],
          ],
          stsc: [[1, 3]],
          chunkOffsets: [2 ** 33],
          co64: true,
          timescale: 90_000,
        }),
      ),
    );
    expect(track?.samples.map((sample) => [sample.offset, sample.timestampUs])).toEqual([
      [2 ** 33, 0],
      [2 ** 33 + 10, 100_000],
      [2 ** 33 + 20, 33_333],
    ]);
  });

  it('takes an identity edit list, and refuses one that moves the picture', () => {
    const elst = (mediaTime: number) =>
      fullBox('elst', 0, u32(1), u32(4000), i32(mediaTime), u32(0x00010000));
    expect(parseVideoTrack(moov(videoTrak({ elst: elst(0) })))).toBeDefined();
    expect(parseVideoTrack(moov(videoTrak({ elst: elst(1000) })))).toBeUndefined();
  });

  it('refuses what it does not read: fragments, other codecs, compact sizes and broken tables', () => {
    expect(parseVideoTrack(moov(videoTrak(), box('mvex')))).toBeUndefined();
    expect(parseVideoTrack(moov(videoTrak({ sampleEntry: avc1('hvc1') })))).toBeUndefined();
    expect(parseVideoTrack(moov(videoTrak({ extraStbl: box('stz2') })))).toBeUndefined();
    expect(parseVideoTrack(moov(videoTrak({ stts: [[3, 1000]] })))).toBeUndefined();
    expect(parseVideoTrack(moov(soundTrak))).toBeUndefined();
    expect(parseVideoTrack(box('free'))).toBeUndefined();
    // A box claiming more than its parent holds.
    const broken = moov(videoTrak());
    new DataView(broken.buffer).setUint32(8 + 108, 0x7fffffff);
    expect(parseVideoTrack(broken)).toBeUndefined();
  });
});

describe('finding the moov', () => {
  /** A reader over `file` that records what it was asked for. */
  function reader(file: Uint8Array) {
    const reads: [number, number][] = [];
    const read = (offset: number, length: number) => {
      reads.push([offset, length]);
      return Promise.resolve(file.subarray(offset, Math.min(file.byteLength, offset + length)));
    };
    return { read, reads };
  }

  it('walks past the media to the moov a recording writes last, reading only headers', async () => {
    const media = box('mdat', new Uint8Array(50_000));
    const index = moov(videoTrak());
    const file = concat(box('ftyp', ascii('isom')), box('uuid', new Uint8Array(23)), media, index);
    const { read, reads } = reader(file);
    expect(await readMoov(read)).toEqual(index);
    // Never the media itself: 16 bytes at each top-level box, then the moov.
    expect(reads.every(([, length]) => length === 16 || length === index.byteLength)).toBe(true);
  });

  it('gives up on fragments, a missing moov and a broken size', async () => {
    const fragmented = concat(box('ftyp', ascii('isom')), box('moof'), box('mdat'));
    expect(await readMoov(reader(fragmented).read)).toBeUndefined();
    expect(await readMoov(reader(box('ftyp', ascii('isom'))).read)).toBeUndefined();
    expect(await readMoov(reader(concat(u32(4), ascii('free'))).read)).toBeUndefined();
  });
});

describe('choosing the frame a video element shows', () => {
  const at = (timestampUs: number, isSync = false): Mp4VideoSample => ({
    offset: 0,
    size: 1,
    timestampUs,
    durationUs: 16_667,
    isSync,
  });

  it('shows the last frame to start at or before the time, or the first before any', () => {
    const samples = [at(66_667, true), at(83_333), at(100_000), at(116_667)];
    const byTime = presentationOrder(samples);
    expect(sampleAt(samples, byTime, 0)).toBe(0);
    expect(sampleAt(samples, byTime, 90_000)).toBe(1);
    expect(sampleAt(samples, byTime, 100_000)).toBe(2);
    // A plan's time truncated to the microsecond still lands on the frame it means.
    expect(sampleAt(samples, byTime, 116_666)).toBe(3);
    expect(sampleAt(samples, byTime, 10_000_000)).toBe(3);
  });

  it('follows presentation order when decode order differs', () => {
    // Decode order I P B B: presented I B B P.
    const samples = [at(0, true), at(50_000), at(16_667), at(33_333)];
    const byTime = presentationOrder(samples);
    expect(byTime).toEqual([0, 2, 3, 1]);
    expect(sampleAt(samples, byTime, 20_000)).toBe(2);
    expect(sampleAt(samples, byTime, 60_000)).toBe(1);
  });

  it('starts decoding at the keyframe before a frame', () => {
    const samples = [at(0, true), at(1), at(2), at(3, true), at(4)];
    expect(syncSampleBefore(samples, 2)).toBe(0);
    expect(syncSampleBefore(samples, 3)).toBe(3);
    expect(syncSampleBefore(samples, 4)).toBe(3);
  });
});
