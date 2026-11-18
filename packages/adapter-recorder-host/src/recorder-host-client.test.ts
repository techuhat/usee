import { randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { encodeFrame, FrameDecoder } from './framing';
import {
  RecorderHostClient,
  RecorderHostConnectionError,
  RecorderHostRequestError,
} from './recorder-host-client';

interface Request {
  readonly id: string;
  readonly method: string;
}

/** A scripted stand-in for the native host on a real named pipe. */
async function fakeHost(onRequest: (request: Request, socket: Socket) => void) {
  const pipePath = `\\\\.\\pipe\\usee-test-${randomBytes(8).toString('hex')}`;
  const server: Server = createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on('data', (chunk: Buffer) => {
      for (const payload of decoder.push(chunk)) {
        onRequest(JSON.parse(payload) as Request, socket);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(pipePath, resolve));
  servers.push(server);
  return RecorderHostClient.connect(pipePath, 2_000);
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

const display = {
  id: 'display-1',
  name: 'Display 1',
  x: 0,
  y: 0,
  width: 1920,
  height: 1080,
  isPrimary: true,
  refreshRateHz: 60,
};

describe('RecorderHostClient', () => {
  it('correlates responses and validates their results', async () => {
    const client = await fakeHost(({ id }, socket) => {
      socket.write(
        encodeFrame({ kind: 'response', id, ok: true, result: { displays: [display] } }),
      );
    });
    await expect(client.request('listDisplays', {})).resolves.toEqual({ displays: [display] });
    client.close();
  });

  it('turns an error response into a typed request error', async () => {
    const client = await fakeHost(({ id }, socket) => {
      const error = { category: 'capture', code: 'capture.source-unavailable', retryable: true };
      socket.write(encodeFrame({ kind: 'response', id, ok: false, error }));
    });
    const failure = client.request('listDisplays', {});
    await expect(failure).rejects.toBeInstanceOf(RecorderHostRequestError);
    await expect(failure).rejects.toMatchObject({
      hostError: { code: 'capture.source-unavailable' },
    });
    client.close();
  });

  it('closes the connection on a malformed result instead of passing it on', async () => {
    const client = await fakeHost(({ id }, socket) => {
      socket.write(encodeFrame({ kind: 'response', id, ok: true, result: { displays: 'nope' } }));
    });
    await expect(client.request('listDisplays', {})).rejects.toThrow(/malformed listDisplays/);
    await client.closed;
  });

  it('delivers known events, ignores unknown ones, and drops malformed ones by closing', async () => {
    const client = await fakeHost((_request, socket) => {
      socket.write(encodeFrame({ kind: 'event', name: 'host.future-event', data: {} }));
      socket.write(
        encodeFrame({
          kind: 'event',
          name: 'session.state',
          data: { sessionId: 's1', state: 'recording', error: null },
        }),
      );
      socket.write(encodeFrame({ kind: 'event', name: 'session.state', data: { state: 'bogus' } }));
    });
    const states: string[] = [];
    client.on('session.state', (event) => states.push(event.state));
    void client.request('listDisplays', {}).catch(() => undefined);
    await client.closed;
    expect(states).toEqual(['recording']);
  });

  it('times out a request the host never answers', async () => {
    const client = await fakeHost(() => undefined);
    await expect(client.request('listDisplays', {}, 50)).rejects.toBeInstanceOf(
      RecorderHostConnectionError,
    );
    client.close();
  });

  it('refuses to send invalid params', async () => {
    const client = await fakeHost(() => undefined);
    expect(() => client.request('stopSession', { sessionId: '../escape' })).toThrow();
    client.close();
  });
});
