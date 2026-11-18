/**
 * Last-resort diagnostics before the structured logger exists (Phase 1).
 * Writes one NDJSON record to stderr with the error's name only: messages can
 * contain user paths, which docs/logging.md forbids in logs.
 */
export function reportFatalError(event: string, cause: unknown): void {
  const record = {
    timestamp: new Date().toISOString(),
    level: 'FATAL',
    event,
    module: 'desktop.main',
    processId: process.pid,
    errorName: cause instanceof Error ? cause.name : typeof cause,
  };
  process.stderr.write(`${JSON.stringify(record)}\n`);
}
