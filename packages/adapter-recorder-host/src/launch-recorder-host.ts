import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';

import { RECORDER_PROTOCOL_VERSION, type RecorderResult } from '@usee/contracts';

import {
  RecorderHostClient,
  RecorderHostConnectionError,
  type RecorderHostChannel,
} from './recorder-host-client';

export interface LaunchRecorderHostOptions {
  readonly executablePath: string;
  /** The only directory the host may write to. */
  readonly stagingRoot: string;
  /** Adds the synthetic test-pattern display (tests and CI only). */
  readonly enableSyntheticSource?: boolean;
  /** Receives each NDJSON log record the host writes to stdout. */
  readonly onLog?: (record: unknown) => void;
  readonly connectTimeoutMs?: number;
}

export interface HostExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface RecorderHost {
  readonly client: RecorderHostChannel;
  readonly hello: RecorderResult<'hello'>;
  readonly exited: Promise<HostExit>;
  /** Asks the host to finalize and exit, then kills it if it does not. */
  shutdown(timeoutMs?: number): Promise<HostExit>;
}

// Variables the host process inherits; everything else stays out of its environment.
const INHERITED_VARIABLES = [
  'SystemRoot',
  'SystemDrive',
  'windir',
  'TEMP',
  'TMP',
  'PATH',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'ProgramData',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
] as const;

/**
 * Starts the recorder host with a per-launch pipe name and token passed
 * through its environment (never the command line), connects, and completes
 * the authenticated hello handshake.
 */
export async function launchRecorderHost(
  options: LaunchRecorderHostOptions,
): Promise<RecorderHost> {
  const pipeName = `\\\\.\\pipe\\usee-recorder-${randomBytes(16).toString('hex')}`;
  const token = randomBytes(32).toString('hex');

  const environment: Record<string, string> = {};
  for (const name of INHERITED_VARIABLES) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  environment['USEE_PIPE_NAME'] = pipeName;
  environment['USEE_HOST_TOKEN'] = token;
  environment['USEE_STAGING_ROOT'] = options.stagingRoot;
  if (options.enableSyntheticSource === true) {
    environment['USEE_SYNTHETIC_SOURCE'] = '1';
  }

  const child = spawn(options.executablePath, [], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const exited = new Promise<HostExit>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', () => resolve({ code: null, signal: null }));
  });

  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      options.onLog?.(JSON.parse(line));
    } catch {
      options.onLog?.({ level: 'WARN', event: 'host.output.unstructured' });
    }
  });
  child.stderr.resume(); // crash text may contain paths; it is not forwarded

  let client: RecorderHostClient;
  try {
    client = await Promise.race([
      RecorderHostClient.connect(pipeName, options.connectTimeoutMs ?? 10_000),
      exited.then((exit) => {
        throw new RecorderHostConnectionError(`Recorder host exited early (code ${exit.code}).`);
      }),
    ]);
  } catch (error) {
    child.kill();
    throw error;
  }

  let hello: RecorderResult<'hello'>;
  try {
    hello = await client.request('hello', {
      protocolMajor: RECORDER_PROTOCOL_VERSION.major,
      protocolMinor: RECORDER_PROTOCOL_VERSION.minor,
      token,
    });
  } catch (error) {
    client.close();
    child.kill();
    throw error;
  }

  return {
    client,
    hello,
    exited,
    async shutdown(timeoutMs = 15_000) {
      try {
        await client.request('shutdown', {}, timeoutMs);
      } catch {
        // Already gone, or not answering: fall through to the kill below.
      }
      const timer = setTimeout(() => child.kill(), timeoutMs);
      const exit = await exited;
      clearTimeout(timer);
      client.close();
      return exit;
    },
  };
}
