import { connect, type Socket } from 'node:net';

import {
  hostMessageSchema,
  recorderEvents,
  recorderMethods,
  type HostError,
  type RecorderEventData,
  type RecorderEventName,
  type RecorderMethod,
  type RecorderParams,
  type RecorderResult,
} from '@usee/contracts';

import { encodeFrame, FrameDecoder, RecorderProtocolError } from './framing';

/** The host answered a request with an error response. */
export class RecorderHostRequestError extends Error {
  override readonly name = 'RecorderHostRequestError';
  constructor(readonly hostError: HostError) {
    super(hostError.code);
  }
}

/** The connection closed, or a request timed out. */
export class RecorderHostConnectionError extends Error {
  override readonly name = 'RecorderHostConnectionError';
}

interface PendingRequest {
  readonly method: RecorderMethod;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

type Listener = (data: unknown) => void;

/** What callers need from a connection; `RecorderHostClient` is the real one. */
export interface RecorderHostChannel {
  readonly closed: Promise<void>;
  request<Method extends RecorderMethod>(
    method: Method,
    params: RecorderParams<Method>,
    timeoutMs?: number,
  ): Promise<RecorderResult<Method>>;
  on<Name extends RecorderEventName>(
    name: Name,
    listener: (data: RecorderEventData<Name>) => void,
  ): () => void;
  close(): void;
}

/**
 * A connected, framed, schema-checked channel to the recorder host. Every
 * response and event is validated before it reaches a caller; anything
 * malformed closes the connection.
 */
export class RecorderHostClient implements RecorderHostChannel {
  readonly #socket: Socket;
  readonly #decoder = new FrameDecoder();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #listeners = new Map<RecorderEventName, Set<Listener>>();
  readonly #closed: Promise<void>;
  #nextId = 1;
  #closeReason: Error | undefined;

  private constructor(socket: Socket) {
    this.#socket = socket;
    this.#closed = new Promise((resolve) => {
      socket.once('close', () => {
        this.#failPending(
          this.#closeReason ?? new RecorderHostConnectionError('Connection closed.'),
        );
        resolve();
      });
    });
    socket.on('data', (chunk: Buffer) => this.#receive(chunk));
    socket.on('error', (error) => {
      this.#closeReason ??= new RecorderHostConnectionError(error.message);
    });
  }

  /** Connects, retrying while the host has not created its pipe yet. */
  static async connect(pipePath: string, timeoutMs: number): Promise<RecorderHostClient> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        return new RecorderHostClient(await openSocket(pipePath));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if ((code !== 'ENOENT' && code !== 'EBUSY') || Date.now() >= deadline) {
          throw new RecorderHostConnectionError(
            `Could not connect to the recorder host (${code}).`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  get closed(): Promise<void> {
    return this.#closed;
  }

  request<Method extends RecorderMethod>(
    method: Method,
    params: RecorderParams<Method>,
    timeoutMs = 10_000,
  ): Promise<RecorderResult<Method>> {
    if (this.#socket.destroyed) {
      return Promise.reject(new RecorderHostConnectionError('Connection closed.'));
    }
    const checkedParams = recorderMethods[method].params.parse(params);
    const id = `r${this.#nextId++}`;

    return new Promise<RecorderResult<Method>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new RecorderHostConnectionError(`Request ${method} timed out.`));
      }, timeoutMs);
      this.#pending.set(id, {
        method,
        resolve: (value) => resolve(value as RecorderResult<Method>),
        reject,
        timer,
      });
      this.#socket.write(encodeFrame({ kind: 'request', id, method, params: checkedParams }));
    });
  }

  on<Name extends RecorderEventName>(
    name: Name,
    listener: (data: RecorderEventData<Name>) => void,
  ): () => void {
    const listeners = this.#listeners.get(name) ?? new Set<Listener>();
    const wrapped: Listener = (data) => listener(data as RecorderEventData<Name>);
    listeners.add(wrapped);
    this.#listeners.set(name, listeners);
    return () => listeners.delete(wrapped);
  }

  close(): void {
    this.#socket.destroy();
  }

  #receive(chunk: Buffer): void {
    try {
      for (const payload of this.#decoder.push(chunk)) {
        this.#handle(payload);
      }
    } catch (error) {
      this.#closeReason =
        error instanceof RecorderProtocolError ? error : new RecorderProtocolError(String(error));
      this.#socket.destroy();
    }
  }

  #handle(payload: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(payload);
    } catch {
      throw new RecorderProtocolError('Host sent invalid JSON.');
    }
    const message = hostMessageSchema.safeParse(raw);
    if (!message.success) {
      throw new RecorderProtocolError('Host sent a malformed envelope.');
    }

    if (message.data.kind === 'event') {
      const { name, data } = message.data;
      if (!(name in recorderEvents)) {
        return; // a newer minor version may add events; ignore unknown ones
      }
      const eventName = name as RecorderEventName;
      const parsed = recorderEvents[eventName].safeParse(data);
      if (!parsed.success) {
        throw new RecorderProtocolError(`Host sent a malformed ${name} event.`);
      }
      for (const listener of this.#listeners.get(eventName) ?? []) {
        listener(parsed.data);
      }
      return;
    }

    const pending = this.#pending.get(message.data.id);
    if (pending === undefined) {
      throw new RecorderProtocolError('Host answered a request that was not sent.');
    }
    this.#pending.delete(message.data.id);
    clearTimeout(pending.timer);

    if (!message.data.ok) {
      pending.reject(new RecorderHostRequestError(message.data.error));
      return;
    }
    const result = recorderMethods[pending.method].result.safeParse(message.data.result);
    if (!result.success) {
      const error = new RecorderProtocolError(`Host sent a malformed ${pending.method} result.`);
      pending.reject(error);
      throw error;
    }
    pending.resolve(result.data);
  }

  #failPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function openSocket(pipePath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(pipePath);
    socket.once('connect', () => {
      socket.removeListener('error', reject);
      resolve(socket);
    });
    socket.once('error', reject);
  });
}
