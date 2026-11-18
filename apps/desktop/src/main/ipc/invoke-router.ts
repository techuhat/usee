import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import {
  createAppError,
  err,
  ok,
  parseInvokeRequest,
  parseInvokeResponse,
  type CorrelationId,
  type DiagnosticValue,
  type InvokeChannel,
  type InvokeRequest,
  type InvokeResponse,
  type Result,
} from '@usee/contracts';

export interface InvokeContext {
  readonly correlationId: CorrelationId;
}

export type InvokeHandler<Channel extends InvokeChannel> = (
  request: InvokeRequest<Channel>,
  context: InvokeContext,
) => Promise<Result<InvokeResponse<Channel>>> | Result<InvokeResponse<Channel>>;

export interface HandlerFailure {
  readonly channel: string;
  readonly correlationId: CorrelationId;
  readonly cause: unknown;
}

export interface InvokeRouterOptions {
  readonly isTrustedSender: (frameUrl: string) => boolean;
  readonly createCorrelationId: () => CorrelationId;
  /** Local diagnostics only; the renderer receives a redacted AppError. */
  readonly onHandlerFailure: (failure: HandlerFailure) => void;
}

export interface InvokeRouter {
  handle<Channel extends InvokeChannel>(definition: Channel, handler: InvokeHandler<Channel>): void;
}

type IpcErrorCode =
  'ipc.untrusted-sender' | 'ipc.invalid-request' | 'ipc.handler-failed' | 'ipc.invalid-response';

/**
 * Registers handlers for allow-listed channels only. Every call is checked in
 * this order: trusted sender frame, request schema, handler, response schema.
 * Handlers never see unvalidated input, and nothing a handler throws reaches
 * the renderer except a structured `AppError`.
 */
export function createInvokeRouter(
  ipc: Pick<IpcMain, 'handle'>,
  options: InvokeRouterOptions,
): InvokeRouter {
  const registeredChannels = new Set<string>();

  async function dispatch<Channel extends InvokeChannel>(
    definition: Channel,
    handler: InvokeHandler<Channel>,
    event: IpcMainInvokeEvent,
    args: readonly unknown[],
  ): Promise<Result<InvokeResponse<Channel>>> {
    const correlationId = options.createCorrelationId();
    const fail = (code: IpcErrorCode, context?: Readonly<Record<string, DiagnosticValue>>) =>
      err(
        createAppError({
          category: 'ipc',
          code,
          retryable: false,
          userMessageKey: `errors.${code}`,
          correlationId,
          ...(context === undefined ? {} : { diagnosticContext: context }),
        }),
      );

    const frameUrl = event.senderFrame?.url;
    if (frameUrl === undefined || !options.isTrustedSender(frameUrl)) {
      return fail('ipc.untrusted-sender', { channel: definition.channel });
    }

    // The bridge sends at most one argument; extra arguments are never ignored silently.
    const request = parseInvokeRequest(definition, args[0]);
    if (args.length > 1 || !request.success) {
      return fail('ipc.invalid-request', { channel: definition.channel });
    }

    let result: Result<InvokeResponse<Channel>>;
    try {
      result = await handler(request.data, { correlationId });
    } catch (cause) {
      options.onHandlerFailure({ channel: definition.channel, correlationId, cause });
      return fail('ipc.handler-failed', { channel: definition.channel });
    }
    if (!result.ok) {
      return result;
    }

    const response = parseInvokeResponse(definition, result.value);
    if (!response.success) {
      options.onHandlerFailure({
        channel: definition.channel,
        correlationId,
        cause: response.error,
      });
      return fail('ipc.invalid-response', { channel: definition.channel });
    }
    return ok(response.data);
  }

  return {
    handle(definition, handler) {
      if (registeredChannels.has(definition.channel)) {
        throw new Error(`An IPC handler is already registered for ${definition.channel}.`);
      }
      registeredChannels.add(definition.channel);
      ipc.handle(definition.channel, (event, ...args: unknown[]) =>
        dispatch(definition, handler, event, args),
      );
    },
  };
}
