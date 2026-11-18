import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openOrderedFrameSource, rangeReader } from './export-video-decoder';
import type { ReadBytes } from './mp4-index';

/** A decoded picture: its timestamp, and whether it was closed. */
class FakeFrame {
  closed = false;
  constructor(readonly timestamp: number) {}
  clone(): FakeFrame {
    return new FakeFrame(this.timestamp);
  }
  close(): void {
    this.closed = true;
  }
}

class FakeChunk {
  readonly type: 'key' | 'delta';
  readonly timestamp: number;
  constructor(init: { type: 'key' | 'delta'; timestamp: number }) {
    this.type = init.type;
    this.timestamp = init.timestamp;
  }
}

/** Outputs each chunk as a frame a task later, as a hardware decoder would. */
class FakeDecoder extends EventTarget {
  static instances: FakeDecoder[] = [];
  static failAt: number | undefined;
  readonly decoded: number[] = [];
  resets = 0;
  state: 'configured' | 'closed' = 'configured';
  decodeQueueSize = 0;
  #pending: FakeChunk[] = [];
  #needsKey = true;
  readonly #init: { output: (frame: FakeFrame) => void; error: (cause: Error) => void };

  constructor(init: { output: (frame: FakeFrame) => void; error: (cause: Error) => void }) {
    super();
    this.#init = init;
    FakeDecoder.instances.push(this);
  }

  static isConfigSupported() {
    return Promise.resolve({ supported: true });
  }

  configure(): void {
    this.#needsKey = true;
  }

  decode(chunk: FakeChunk): void {
    if (this.#needsKey && chunk.type !== 'key') {
      throw new Error('A delta chunk after configure.');
    }
    this.#needsKey = false;
    this.decoded.push(chunk.timestamp);
    this.#pending.push(chunk);
    this.decodeQueueSize += 1;
    setTimeout(() => this.#emit(), 0);
  }

  #emit(): void {
    const chunk = this.#pending.shift();
    if (chunk === undefined) return;
    this.decodeQueueSize -= 1;
    this.dispatchEvent(new Event('dequeue'));
    if (chunk.timestamp === FakeDecoder.failAt) {
      this.#init.error(new Error('Decoding failed.'));
      return;
    }
    this.#init.output(new FakeFrame(chunk.timestamp));
  }

  flush(): Promise<void> {
    while (this.#pending.length > 0) this.#emit();
    return Promise.resolve();
  }

  reset(): void {
    this.#pending = [];
    this.decodeQueueSize = 0;
    this.resets += 1;
  }

  close(): void {
    this.state = 'closed';
  }
}

// ---- A small MP4 in memory: 16 frames at 60 fps, keyframes at 0 and 8. ----

const u32 = (value: number) =>
  Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
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
const fullBox = (type: string, ...body: Uint8Array[]) => box(type, u32(0), ...body);

const FRAME_COUNT = 16;
const SAMPLE_SIZE = 10;
const MEDIA_START = 16;
const frameUs = (index: number) => Math.round((index * 1_000_000) / 60);

function recording(): Uint8Array {
  const avc1 = box(
    'avc1',
    new Uint8Array(24),
    Uint8Array.of(0x07, 0x80, 0x04, 0x38),
    new Uint8Array(50),
    box('avcC', Uint8Array.of(1, 0x64, 0, 0x28)),
  );
  const moov = box(
    'moov',
    box(
      'trak',
      box(
        'mdia',
        fullBox('mdhd', u32(0), u32(0), u32(60_000), u32(0), u32(0)),
        fullBox('hdlr', u32(0), ascii('vide'), new Uint8Array(13)),
        box(
          'minf',
          box(
            'stbl',
            fullBox('stsd', u32(1), avc1),
            fullBox('stts', u32(1), u32(FRAME_COUNT), u32(1000)),
            fullBox('stss', u32(2), u32(1), u32(9)),
            fullBox('stsz', u32(SAMPLE_SIZE), u32(FRAME_COUNT)),
            fullBox('stsc', u32(1), u32(1), u32(FRAME_COUNT), u32(1)),
            fullBox('stco', u32(1), u32(MEDIA_START + 8)),
          ),
        ),
      ),
    ),
  );
  return concat(
    box('ftyp', ascii('isom')),
    box('mdat', new Uint8Array(FRAME_COUNT * SAMPLE_SIZE)),
    moov,
  );
}

const file = recording();
const read: ReadBytes = (offset, length) =>
  Promise.resolve(file.subarray(offset, Math.min(file.byteLength, offset + length)));

beforeEach(() => {
  FakeDecoder.instances = [];
  FakeDecoder.failAt = undefined;
  vi.stubGlobal('VideoDecoder', FakeDecoder);
  vi.stubGlobal('EncodedVideoChunk', FakeChunk);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function open() {
  const source = await openOrderedFrameSource('app://media/token/video', read);
  if (source === undefined) throw new Error('The recording should decode in order.');
  const decoder = FakeDecoder.instances[0];
  if (decoder === undefined) throw new Error('No decoder was made.');
  return { source, decoder };
}

describe('decoding a recording in order', () => {
  it('decodes each frame once as export asks for them in time order', async () => {
    const { source, decoder } = await open();
    for (const index of [0, 1, 2, 3]) {
      const frame = await source.frameAt(frameUs(index));
      expect(frame.timestamp).toBe(frameUs(index));
      frame.close();
    }
    // Only what was needed, never the same sample twice, never a restart.
    expect(decoder.decoded.slice(0, 4)).toEqual([0, 1, 2, 3].map(frameUs));
    expect(new Set(decoder.decoded).size).toBe(decoder.decoded.length);
    expect(decoder.resets).toBe(0);
  });

  it('shows a slowed clip’s repeated frame again without decoding anything', async () => {
    const { source, decoder } = await open();
    (await source.frameAt(frameUs(1))).close();
    const fed = decoder.decoded.length;
    const again = await source.frameAt(frameUs(1) + 5_000);
    expect(again.timestamp).toBe(frameUs(1));
    expect(decoder.decoded).toHaveLength(fed);
  });

  it('starts over at a keyframe to go back, or to skip ahead past one', async () => {
    const { source, decoder } = await open();
    (await source.frameAt(frameUs(1))).close();
    // Ahead past the keyframe at 8: start there instead of decoding up to it.
    const ahead = await source.frameAt(frameUs(13));
    expect(ahead.timestamp).toBe(frameUs(13));
    expect(decoder.resets).toBe(1);
    expect(decoder.decoded).not.toContain(frameUs(7));
    // Back to 2: from the keyframe at 0.
    const back = await source.frameAt(frameUs(2));
    expect(back.timestamp).toBe(frameUs(2));
    expect(decoder.resets).toBe(2);
    const restarted = decoder.decoded.lastIndexOf(frameUs(0));
    expect(decoder.decoded.slice(restarted, restarted + 3)).toEqual([0, 1, 2].map(frameUs));
  });

  it('lists when its keyframes show, which decode on their own', async () => {
    const { source } = await open();
    expect(source.keyframeTimesUs()).toEqual([frameUs(0), frameUs(8)]);
  });

  it('reaches the last frame, flushing the decoder', async () => {
    const { source } = await open();
    const last = await source.frameAt(frameUs(FRAME_COUNT) + 40_000);
    expect(last.timestamp).toBe(frameUs(FRAME_COUNT - 1));
  });

  it('fails when the decoder does, so export can seek this recording instead', async () => {
    FakeDecoder.failAt = frameUs(1);
    const { source } = await open();
    await expect(source.frameAt(frameUs(2))).rejects.toThrow('Decoding failed.');
  });

  it('is not offered where WebCodecs is missing or the file is not a recording', async () => {
    vi.stubGlobal('VideoDecoder', undefined);
    expect(await openOrderedFrameSource('app://media/token/video', read)).toBeUndefined();
    vi.stubGlobal('VideoDecoder', FakeDecoder);
    const notMp4: ReadBytes = () => Promise.resolve(new Uint8Array(4));
    expect(await openOrderedFrameSource('app://media/token/video', notMp4)).toBeUndefined();
  });
});

describe('reading media in byte ranges', () => {
  it('reads a window at a time and answers later reads inside it from memory', async () => {
    const media = Uint8Array.from({ length: 64 }, (_, index) => index);
    const fetches: string[] = [];
    const fetchBytes = (_url: RequestInfo | URL, init?: RequestInit) => {
      const range = new Headers(init?.headers).get('Range') ?? '';
      fetches.push(range);
      const [, first = '0'] = /bytes=(\d+)-/.exec(range) ?? [];
      return Promise.resolve(new Response(media.slice(Number(first)), { status: 206 }));
    };
    const reader = rangeReader('app://media/token/video', fetchBytes);
    expect(await reader(4, 3)).toEqual(Uint8Array.of(4, 5, 6));
    expect(await reader(10, 2)).toEqual(Uint8Array.of(10, 11));
    expect(fetches).toEqual([`bytes=4-${4 + 4 * 1024 * 1024 - 1}`]);
  });

  it('treats a range past the end as the end, and never takes a whole file', async () => {
    const answer = (status: number) => () => Promise.resolve(new Response(null, { status }));
    expect(await rangeReader('u', answer(416) as typeof fetch)(100, 8)).toEqual(new Uint8Array(0));
    await expect(rangeReader('u', answer(200) as typeof fetch)(0, 8)).rejects.toThrow('200');
  });
});
