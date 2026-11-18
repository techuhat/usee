import type { RecorderHostEvent, RecorderHostPort } from '@usee/application';
import {
  createAppError,
  err,
  hostErrorToAppError,
  ok,
  type AppError,
  type CorrelationId,
  type RecorderMethod,
  type RecorderParams,
  type RecorderResult,
  type Result,
} from '@usee/contracts';

import { RecorderProtocolError } from './framing';
import {
  launchRecorderHost,
  type LaunchRecorderHostOptions,
  type RecorderHost,
} from './launch-recorder-host';
import { RecorderHostRequestError } from './recorder-host-client';

export interface RecorderHostSupervisorOptions extends LaunchRecorderHostOptions {
  readonly createCorrelationId: () => CorrelationId;
  /** Replaces the real launcher in tests. */
  readonly launch?: (options: LaunchRecorderHostOptions) => Promise<RecorderHost>;
}

export interface RecorderHostSupervisor extends RecorderHostPort {
  /** Finalizes any session, stops the host and refuses further calls. */
  dispose(): Promise<void>;
}

const START_TIMEOUT_MS = 30_000;
// Stopping waits for the last segment to finalize and hash.
const STOP_TIMEOUT_MS = 120_000;
// Merging copies the whole recording once, about 3 GB for 30 minutes at
// today's bitrate; this bounds even very long sessions on a slow disk.
const MERGE_TIMEOUT_MS = 30 * 60_000;

/**
 * Owns the recorder-host process for the application: launched on first use,
 * relaunched on the next call after a crash, and reported as `host-lost` when
 * it exits unasked (docs/recording-pipeline.md, "Error and recovery contract").
 */
export function createRecorderHostSupervisor(
  options: RecorderHostSupervisorOptions,
): RecorderHostSupervisor {
  const launch = options.launch ?? launchRecorderHost;
  const listeners = new Set<(event: RecorderHostEvent) => void>();
  let current: Promise<RecorderHost> | undefined;
  let disposed = false;

  const emit = (event: RecorderHostEvent) => {
    for (const listener of listeners) {
      listener(event);
    }
  };
  const nativeError = (code: string, retryable: boolean): AppError =>
    createAppError({
      category: 'native',
      code,
      retryable,
      userMessageKey: `errors.${code}`,
      correlationId: options.createCorrelationId(),
    });

  function connect(): Promise<RecorderHost> {
    if (current !== undefined) {
      return current;
    }
    const launching = launch(options).then((host) => {
      host.client.on('session.metrics', (data) =>
        emit({
          type: 'metrics',
          sessionId: data.sessionId,
          metrics: {
            elapsedUs: data.elapsedUs,
            framesEncoded: data.framesEncoded,
            framesDropped: data.framesDropped,
          },
        }),
      );
      host.client.on('session.stream-failed', (data) =>
        emit({
          type: 'stream-failed',
          sessionId: data.sessionId,
          stream: data.stream,
          error: hostErrorToAppError(data.error, options.createCorrelationId()),
        }),
      );
      host.client.on('session.state', (data) => {
        if (data.state === 'failed' && data.error !== null) {
          emit({
            type: 'session-failed',
            sessionId: data.sessionId,
            error: hostErrorToAppError(data.error, options.createCorrelationId()),
          });
        }
      });
      void host.exited.then(() => {
        if (current === launching) {
          current = undefined;
        }
        if (!disposed) {
          emit({ type: 'host-lost', error: nativeError('native.host-crashed', true) });
        }
      });
      return host;
    });
    current = launching;
    launching.catch(() => {
      if (current === launching) {
        current = undefined;
      }
    });
    return launching;
  }

  async function call<Method extends RecorderMethod>(
    method: Method,
    params: RecorderParams<Method>,
    timeoutMs?: number,
  ): Promise<Result<RecorderResult<Method>>> {
    if (disposed) {
      return err(nativeError('native.host-unavailable', false));
    }
    try {
      const host = await connect();
      return ok(await host.client.request(method, params, timeoutMs));
    } catch (error) {
      if (error instanceof RecorderHostRequestError) {
        return err(hostErrorToAppError(error.hostError, options.createCorrelationId()));
      }
      if (error instanceof RecorderProtocolError) {
        return err(nativeError('native.protocol-violation', false));
      }
      return err(nativeError('native.host-unavailable', true));
    }
  }

  return {
    async listDisplays() {
      const result = await call('listDisplays', {});
      return result.ok ? ok(result.value.displays) : result;
    },
    async listWindows() {
      const result = await call('listWindows', {});
      return result.ok ? ok(result.value.windows) : result;
    },
    async listAudioInputs() {
      const result = await call('listAudioInputs', {});
      return result.ok ? ok(result.value.inputs) : result;
    },
    startSession(params) {
      return call('startSession', params, START_TIMEOUT_MS);
    },
    stopSession(sessionId) {
      return call('stopSession', { sessionId }, STOP_TIMEOUT_MS);
    },
    mergeSession(sessionId, { verifyHashes }) {
      return call('mergeSession', { sessionId, verifyHashes }, MERGE_TIMEOUT_MS);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async dispose() {
      disposed = true;
      const running = current;
      current = undefined;
      if (running !== undefined) {
        try {
          await (await running).shutdown();
        } catch {
          // It never started, or is already gone.
        }
      }
    },
  };
}
