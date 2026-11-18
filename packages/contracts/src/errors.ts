import { z } from 'zod';

import { correlationIdSchema, type CorrelationId } from './ids';

/** Error categories and their owners are listed in docs/error-handling.md. */
export const ERROR_CATEGORIES = [
  'capture',
  'audio',
  'encoding',
  'rendering',
  'storage',
  'project',
  'export',
  'native',
  'ipc',
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

/** `<category>.<kebab-case-reason>`, for example `ipc.untrusted-sender`. */
const ERROR_CODE_PATTERN = /^[a-z]+(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/;

/** Dotted lower-case key into the UI's safe copy, for example `errors.ipc.unavailable`. */
const MESSAGE_KEY_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/;

const diagnosticValueSchema = z.union([z.string().max(512), z.number(), z.boolean()]);
export type DiagnosticValue = z.output<typeof diagnosticValueSchema>;

/**
 * The only error shape that crosses a module, process or IPC boundary.
 * `diagnosticContext` is redacted support context: never paths, device names,
 * window titles, tokens or FFmpeg arguments.
 */
export const appErrorSchema = z
  .object({
    category: z.enum(ERROR_CATEGORIES),
    code: z.string().max(96).regex(ERROR_CODE_PATTERN),
    retryable: z.boolean(),
    userMessageKey: z.string().max(128).regex(MESSAGE_KEY_PATTERN),
    correlationId: correlationIdSchema,
    diagnosticContext: z.record(z.string().max(64), diagnosticValueSchema).readonly().optional(),
  })
  .readonly()
  .refine((error) => error.code.startsWith(`${error.category}.`), {
    error: 'An error code must start with its category, for example "ipc.invalid-request".',
    path: ['code'],
  });

export type AppError = z.output<typeof appErrorSchema>;

export interface AppErrorFields {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly retryable: boolean;
  readonly userMessageKey: string;
  readonly correlationId: CorrelationId;
  readonly diagnosticContext?: Readonly<Record<string, DiagnosticValue>>;
}

/**
 * Builds a validated `AppError`. Invalid fields are programmer errors, so this
 * throws instead of returning a result.
 */
export function createAppError(fields: AppErrorFields): AppError {
  return appErrorSchema.parse(fields);
}
