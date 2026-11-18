import { describe, expect, it } from 'vitest';

import { encodeFrame, FrameDecoder, RecorderProtocolError } from './framing';

describe('framing', () => {
  it('writes a little-endian length before the JSON payload', () => {
    const frame = encodeFrame({ a: 1 });
    expect(frame.readUInt32LE(0)).toBe(7);
    expect(frame.subarray(4).toString('utf8')).toBe('{"a":1}');
  });

  it('reassembles frames split across and merged within chunks', () => {
    const stream = Buffer.concat([encodeFrame({ n: 1 }), encodeFrame({ n: 2 })]);
    const decoder = new FrameDecoder();
    expect(decoder.push(stream.subarray(0, 3))).toEqual([]);
    expect(decoder.push(stream.subarray(3, 13))).toEqual(['{"n":1}']);
    expect(decoder.push(stream.subarray(13))).toEqual(['{"n":2}']);
    expect(decoder.pendingBytes).toBe(0);
  });

  it('rejects empty and oversized frames', () => {
    expect(() => new FrameDecoder().push(Buffer.alloc(4))).toThrow(RecorderProtocolError);
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32LE(64 * 1024 + 1, 0);
    expect(() => new FrameDecoder().push(oversized)).toThrow(RecorderProtocolError);
    expect(() => encodeFrame({ text: 'x'.repeat(64 * 1024) })).toThrow(RecorderProtocolError);
  });
});
