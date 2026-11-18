import { RECORDER_MAX_FRAME_BYTES } from '@usee/contracts';

/** Thrown for any message that breaks the wire protocol; the connection is then closed. */
export class RecorderProtocolError extends Error {
  override readonly name = 'RecorderProtocolError';
}

/** A 4-byte little-endian length followed by UTF-8 JSON (docs/recorder-host-protocol.md). */
export function encodeFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.length === 0 || payload.length > RECORDER_MAX_FRAME_BYTES) {
    throw new RecorderProtocolError(`Frame payload of ${payload.length} bytes is out of range.`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/** Reassembles frames from a byte stream that may split or merge them. */
export class FrameDecoder {
  #buffer: Buffer = Buffer.alloc(0);

  /** Returns every payload, as text, completed by `chunk`. */
  push(chunk: Buffer): string[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const payloads: string[] = [];

    let offset = 0;
    while (this.#buffer.length - offset >= 4) {
      const length = this.#buffer.readUInt32LE(offset);
      if (length === 0 || length > RECORDER_MAX_FRAME_BYTES) {
        throw new RecorderProtocolError(`Frame length ${length} is out of range.`);
      }
      if (this.#buffer.length - offset - 4 < length) {
        break;
      }
      payloads.push(this.#buffer.toString('utf8', offset + 4, offset + 4 + length));
      offset += 4 + length;
    }

    this.#buffer = this.#buffer.subarray(offset);
    return payloads;
  }

  get pendingBytes(): number {
    return this.#buffer.length;
  }
}
