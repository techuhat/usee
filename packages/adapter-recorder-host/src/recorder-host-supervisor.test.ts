import { describe, expect, it, vi } from 'vitest';

import type { RecorderHostEvent } from '@usee/application';
import { asCorrelationId, type RecorderEventData, type RecorderEventName } from '@usee/contracts';

import type { HostExit, RecorderHost } from './launch-recorder-host';
import { RecorderHostConnectionError, RecorderHostRequestError } from './recorder-host-client';
import { createRecorderHostSupervisor } from './recorder-host-supervisor';

/** A controllable stand-in for a launched host process. */
function fakeHost(
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>,
) {
  let exit: (value: HostExit) => void = () => undefined;
  const listeners = new Map<string, (data: unknown) => void>();
  const shutdown = vi.fn(() => Promise.resolve({ code: 0, signal: null }));
  const host: RecorderHost = {
    hello: {
      protocolMajor: 1,
      protocolMinor: 0,
      hostVersion: '0.1.0',
      capabilities: { displayCapture: true, microphone: true, syntheticSource: false },
    },
    exited: new Promise((resolve) => (exit = resolve)),
    shutdown,
    client: {
      closed: new Promise(() => undefined),
      close: () => undefined,
      request: (method, params, timeoutMs) => request(method, params, timeoutMs) as never,
      on: (name, listener) => {
        listeners.set(name, listener as (data: unknown) => void);
        return () => listeners.delete(name);
      },
    },
  };
  return {
    host,
    shutdown,
    exit: () => exit({ code: 1, signal: null }),
    send: <Name extends RecorderEventName>(name: Name, data: RecorderEventData<Name>) =>
      listeners.get(name)?.(data),
  };
}

function supervisorFor(...hosts: RecorderHost[]) {
  const launch = vi.fn(() => {
    const next = hosts.shift();
    return next === undefined
      ? Promise.reject(new RecorderHostConnectionError('gone'))
      : Promise.resolve(next);
  });
  const supervisor = createRecorderHostSupervisor({
    executablePath: 'recorder-host.exe',
    stagingRoot: 'C:/staging',
    createCorrelationId: () => asCorrelationId('corr'),
    launch,
  });
  const events: RecorderHostEvent[] = [];
  supervisor.subscribe((event) => events.push(event));
  return { supervisor, launch, events };
}

describe('recorder host supervisor', () => {
  it('launches once and reuses the host', async () => {
    const fake = fakeHost(() => Promise.resolve({ displays: [], inputs: [] }));
    const { supervisor, launch } = supervisorFor(fake.host);
    await supervisor.listDisplays();
    await supervisor.listAudioInputs();
    expect(launch).toHaveBeenCalledOnce();
  });

  it('gives a merge minutes, not the default request timeout', async () => {
    const request = vi.fn((_method: string, _params?: unknown, _timeoutMs?: number) =>
      Promise.resolve({}),
    );
    const { supervisor } = supervisorFor(fakeHost(request).host);
    await supervisor.mergeSession('session-1', { verifyHashes: true });

    expect(request).toHaveBeenCalledWith(
      'mergeSession',
      { sessionId: 'session-1', verifyHashes: true },
      expect.any(Number),
    );
    expect(request.mock.calls[0]?.[2]).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it('maps host error responses and connection failures to AppErrors', async () => {
    const fake = fakeHost(() =>
      Promise.reject(
        new RecorderHostRequestError({
          category: 'capture',
          code: 'capture.source-unavailable',
          retryable: true,
        }),
      ),
    );
    const { supervisor } = supervisorFor(fake.host);
    await expect(supervisor.listDisplays()).resolves.toMatchObject({
      ok: false,
      error: {
        category: 'capture',
        code: 'capture.source-unavailable',
        userMessageKey: 'errors.capture.source-unavailable',
      },
    });

    const { supervisor: unreachable } = supervisorFor();
    await expect(unreachable.listDisplays()).resolves.toMatchObject({
      ok: false,
      error: { code: 'native.host-unavailable', retryable: true },
    });
  });

  it('forwards session events', async () => {
    const fake = fakeHost(() => Promise.resolve({ displays: [] }));
    const { supervisor, events } = supervisorFor(fake.host);
    await supervisor.listDisplays();

    fake.send('session.metrics', {
      sessionId: 's1',
      elapsedUs: 1,
      framesCaptured: 2,
      framesEncoded: 3,
      framesDropped: 4,
      audioFrames: 5,
      audioDiscontinuities: 0,
    });
    fake.send('session.state', {
      sessionId: 's1',
      state: 'failed',
      error: { category: 'capture', code: 'capture.source-closed', retryable: false },
    });
    expect(events).toEqual([
      {
        type: 'metrics',
        sessionId: 's1',
        metrics: { elapsedUs: 1, framesEncoded: 3, framesDropped: 4 },
      },
      {
        type: 'session-failed',
        sessionId: 's1',
        error: expect.objectContaining({ code: 'capture.source-closed' }) as unknown,
      },
    ]);
  });

  it('reports a crash and relaunches on the next call', async () => {
    const first = fakeHost(() => Promise.resolve({ displays: [] }));
    const second = fakeHost(() => Promise.resolve({ displays: [] }));
    const { supervisor, launch, events } = supervisorFor(first.host, second.host);
    await supervisor.listDisplays();

    first.exit();
    await vi.waitFor(() =>
      expect(events).toContainEqual(expect.objectContaining({ type: 'host-lost' })),
    );

    await supervisor.listDisplays();
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('shuts the host down on dispose without reporting a crash', async () => {
    const fake = fakeHost(() => Promise.resolve({ displays: [] }));
    const { supervisor, events } = supervisorFor(fake.host);
    await supervisor.listDisplays();

    await supervisor.dispose();
    fake.exit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.shutdown).toHaveBeenCalledOnce();
    expect(events).toEqual([]);
    await expect(supervisor.listDisplays()).resolves.toMatchObject({ ok: false });
  });
});
