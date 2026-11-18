import { describe, expect, it } from 'vitest';

import { decodePointerStream } from './pointer-stream';

const header =
  '{"format":"usee.pointer","version":1,"sessionId":"s","coordinateSpace":"capture","display":{"width":3840,"height":2160,"dpiScale":2.0000}}';

describe('decodePointerStream', () => {
  it('reads the header and every kind of event, in time order', () => {
    const text = [
      header,
      '{"t":0,"type":"visibility","visible":true}',
      '{"t":0,"type":"shape","shape":"text"}',
      '{"t":20000,"type":"move","x":0.25000,"y":-0.10000}',
      '{"t":10000,"type":"down","button":"left","x":0.20000,"y":0.30000}',
      '{"t":15000,"type":"up","button":"left","x":0.20000,"y":0.30000}',
      '{"t":30000,"type":"shape","shape":"laser-beam"}',
      '{"t":40000,"type":"mo',
      '',
    ].join('\n');

    const decoded = decodePointerStream(text);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.skippedLines).toBe(1);
    expect(decoded.value.stream.display).toEqual({ width: 3840, height: 2160, dpiScale: 2 });
    expect(decoded.value.stream.events.map((event) => [event.timeUs, event.type])).toEqual([
      [0, 'visibility'],
      [0, 'shape'],
      [10_000, 'down'],
      [15_000, 'up'],
      [20_000, 'move'],
      [30_000, 'shape'],
    ]);
    expect(decoded.value.stream.events[1]).toMatchObject({ shape: 'text' });
    expect(decoded.value.stream.events[2]).toMatchObject({ button: 'left', x: 0.2, y: 0.3 });
    // A kind this build does not know draws as the arrow.
    expect(decoded.value.stream.events[5]).toMatchObject({ shape: 'arrow' });
  });

  it('reads a stream recorded under the working title', () => {
    const legacy = header.replace('"usee.pointer"', '"screen-studio.pointer"');
    const decoded = decodePointerStream(`${legacy}\n{"t":0,"type":"move","x":0.5,"y":0.5}\n`);
    expect(decoded.ok && decoded.value.stream.events).toHaveLength(1);
  });

  it('refuses a stream without a valid header', () => {
    expect(decodePointerStream('').ok).toBe(false);
    expect(decodePointerStream('{"format":"other"}\n').ok).toBe(false);
    expect(decodePointerStream(header.replace('"version":1', '"version":2')).ok).toBe(false);
  });

  it('skips events with impossible values', () => {
    const decoded = decodePointerStream(
      [
        header,
        '{"t":-5,"type":"move","x":0.1,"y":0.1}',
        '{"t":5,"type":"move","x":1000,"y":0.1}',
        '{"t":5,"type":"down","button":"thumb","x":0.1,"y":0.1}',
      ].join('\n'),
    );
    expect(decoded.ok && decoded.value).toMatchObject({ skippedLines: 3, stream: { events: [] } });
  });
});
