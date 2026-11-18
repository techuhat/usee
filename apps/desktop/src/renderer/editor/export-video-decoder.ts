import {
  parseVideoTrack,
  presentationOrder,
  readMoov,
  sampleAt,
  syncSampleBefore,
  type Mp4VideoTrack,
  type ReadBytes,
} from './mp4-index';

/**
 * Export's source pictures, decoded in order with WebCodecs: export asks for
 * frames in time order, so each request decodes only the samples since the
 * last one, where seeking a video element decoded from the last keyframe
 * every time. It shows the frame a video element would show at a time.
 */
export interface OrderedFrameSource {
  /** The frame at `sourceUs`; the caller closes it. */
  frameAt(sourceUs: number): Promise<VideoFrame>;
  /** When each keyframe shows, in order: frames that decode on their own, cheaply. */
  keyframeTimesUs(): readonly number[];
  close(): void;
}

/** Media is read in windows this large, so frames in order rarely wait for a fetch. */
const WINDOW_BYTES = 4 * 1024 * 1024;
/** Chunks queued in the decoder before feeding waits for it to take them. */
const MAX_DECODE_QUEUE = 4;

/** Reads the open project's media through `app://media`, which serves byte ranges. */
export function rangeReader(url: string, fetchBytes: typeof fetch = fetch): ReadBytes {
  let window: { readonly start: number; readonly bytes: Uint8Array } | undefined;
  return async (offset, length) => {
    if (
      window !== undefined &&
      offset >= window.start &&
      offset + length <= window.start + window.bytes.byteLength
    ) {
      return window.bytes.subarray(offset - window.start, offset - window.start + length);
    }
    const wanted = Math.max(length, WINDOW_BYTES);
    const response = await fetchBytes(url, {
      headers: { Range: `bytes=${offset}-${offset + wanted - 1}` },
    });
    if (response.status === 416) {
      return new Uint8Array(0);
    }
    // A 200 would be the whole file: only a range is ever read.
    if (response.status !== 206) {
      throw new Error(`The media server answered ${response.status} to a range.`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    window = { start: offset, bytes };
    return bytes.subarray(0, Math.min(length, bytes.byteLength));
  };
}

class TrackDecoder implements OrderedFrameSource {
  readonly #track: Mp4VideoTrack;
  readonly #byTime: readonly number[];
  readonly #read: ReadBytes;
  readonly #config: VideoDecoderConfig;
  readonly #decoder: VideoDecoder;
  /** Decoded frames not yet shown, in presentation order. */
  #decoded: VideoFrame[] = [];
  /** The frame shown last, kept for the requests a slowed-down clip repeats. */
  #shown: VideoFrame | undefined;
  /** The next sample to decode, in decode order. */
  #next = 0;
  /** The latest timestamp decoded since the decoder last started over. */
  #latestUs = -Infinity;
  #flushed = false;
  #failure: unknown;
  #wake: (() => void) | undefined;

  constructor(track: Mp4VideoTrack, read: ReadBytes, config: VideoDecoderConfig) {
    this.#track = track;
    this.#byTime = presentationOrder(track.samples);
    this.#read = read;
    this.#config = config;
    this.#decoder = new VideoDecoder({
      output: (frame) => {
        this.#latestUs = Math.max(this.#latestUs, frame.timestamp);
        const at = this.#decoded.findIndex((queued) => queued.timestamp > frame.timestamp);
        this.#decoded.splice(at === -1 ? this.#decoded.length : at, 0, frame);
        this.#notify();
      },
      error: (cause) => {
        this.#failure = cause;
        this.#notify();
      },
    });
    this.#decoder.addEventListener('dequeue', () => this.#notify());
    this.#decoder.configure(config);
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }

  /** Waits for the decoder to output, take a chunk or fail. */
  #progress(): Promise<void> {
    return new Promise((resolve) => {
      this.#wake = resolve;
    });
  }

  #restartAt(index: number): void {
    this.#decoder.reset();
    this.#decoder.configure(this.#config);
    for (const frame of this.#decoded) {
      frame.close();
    }
    this.#decoded = [];
    this.#next = index;
    this.#latestUs = -Infinity;
    this.#flushed = false;
  }

  async #feed(index: number): Promise<void> {
    const sample = this.#track.samples[index];
    if (sample === undefined) {
      throw new Error('No such sample.');
    }
    const data = await this.#read(sample.offset, sample.size);
    if (data.byteLength !== sample.size) {
      throw new Error('The media ended inside a sample.');
    }
    this.#decoder.decode(
      new EncodedVideoChunk({
        type: sample.isSync ? 'key' : 'delta',
        timestamp: sample.timestampUs,
        duration: sample.durationUs,
        data,
      }),
    );
  }

  async frameAt(sourceUs: number): Promise<VideoFrame> {
    const samples = this.#track.samples;
    const target = sampleAt(samples, this.#byTime, sourceUs);
    const targetUs = samples[target]?.timestampUs ?? 0;
    if (this.#shown?.timestamp === targetUs) {
      return this.#shown.clone();
    }
    const waiting = this.#decoded.some((frame) => frame.timestamp === targetUs);
    const keyframe = syncSampleBefore(samples, target);
    // Behind what was decoded, or past a keyframe the decoder has not reached:
    // start over at the keyframe before the target instead of decoding up to it.
    if ((!waiting && targetUs <= this.#latestUs) || keyframe > this.#next) {
      this.#restartAt(keyframe);
    }
    for (;;) {
      if (this.#failure !== undefined) {
        throw this.#failure instanceof Error ? this.#failure : new Error('Decoding failed.');
      }
      while ((this.#decoded[0]?.timestamp ?? Infinity) < targetUs) {
        this.#decoded.shift()?.close();
      }
      const first = this.#decoded[0];
      if (first !== undefined && first.timestamp === targetUs) {
        this.#decoded.shift();
        this.#shown?.close();
        this.#shown = first;
        return first.clone();
      }
      if (first !== undefined) {
        throw new Error('The decoder skipped the frame asked for.');
      }
      if (this.#next < samples.length) {
        if (this.#decoder.decodeQueueSize >= MAX_DECODE_QUEUE) {
          await this.#progress();
        } else {
          await this.#feed(this.#next);
          this.#next += 1;
        }
      } else if (!this.#flushed) {
        this.#flushed = true;
        await this.#decoder.flush();
      } else {
        throw new Error('The frame asked for never decoded.');
      }
    }
  }

  keyframeTimesUs(): readonly number[] {
    return this.#track.samples
      .filter((sample) => sample.isSync)
      .map((sample) => sample.timestampUs)
      .sort((first, second) => first - second);
  }

  close(): void {
    for (const frame of this.#decoded) {
      frame.close();
    }
    this.#decoded = [];
    this.#shown?.close();
    this.#shown = undefined;
    if (this.#decoder.state !== 'closed') {
      this.#decoder.close();
    }
  }
}

/**
 * Opens `url` for decoding in order, or gives undefined when this recording
 * or this machine cannot: the caller then seeks a video element instead.
 */
export async function openOrderedFrameSource(
  url: string,
  read: ReadBytes = rangeReader(url),
): Promise<OrderedFrameSource | undefined> {
  if (typeof VideoDecoder === 'undefined') {
    return undefined;
  }
  const moov = await readMoov(read);
  const track = moov === undefined ? undefined : parseVideoTrack(moov);
  if (track === undefined) {
    return undefined;
  }
  const config: VideoDecoderConfig = {
    codec: track.codec,
    description: track.description,
    codedWidth: track.codedWidth,
    codedHeight: track.codedHeight,
    optimizeForLatency: true,
  };
  const support = await VideoDecoder.isConfigSupported(config);
  return support.supported === true ? new TrackDecoder(track, read, config) : undefined;
}
