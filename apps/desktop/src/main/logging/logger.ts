import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';
export type SafeContext = Readonly<Record<string, string | number | boolean>>;

export interface Logger {
  log(level: LogLevel, event: string, module: string, safeContext?: SafeContext): void;
}

export interface FileLoggerOptions {
  readonly directory: string;
  readonly appVersion: string;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
}

/**
 * Replaces the user's profile directory in a string, so a path that slips into
 * a log line never names the account (docs/logging.md, "Privacy rules").
 */
export function redactUserPaths(value: string, profileDirectory: string | undefined): string {
  if (profileDirectory === undefined || profileDirectory === '') {
    return value;
  }
  const variants = new Set([profileDirectory, profileDirectory.replaceAll('\\', '/')]);
  let result = value;
  for (const variant of variants) {
    result = result.split(variant).join('%USERPROFILE%');
  }
  return result;
}

/**
 * NDJSON log file with size-based rotation (`main.ndjson`, `main.1.ndjson`, …).
 * Writes are synchronous: volume is low, and a record written just before a
 * crash must not be lost in a buffer.
 */
export function createFileLogger(options: FileLoggerOptions): Logger {
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const maxFiles = options.maxFiles ?? 3;
  const file = path.join(options.directory, 'main.ndjson');
  const profile = process.env['USERPROFILE'];
  mkdirSync(options.directory, { recursive: true });

  const rotateIfNeeded = () => {
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return;
    }
    if (size < maxBytes) {
      return;
    }
    rmSync(path.join(options.directory, `main.${maxFiles - 1}.ndjson`), { force: true });
    for (let index = maxFiles - 2; index >= 1; index -= 1) {
      try {
        renameSync(
          path.join(options.directory, `main.${index}.ndjson`),
          path.join(options.directory, `main.${index + 1}.ndjson`),
        );
      } catch {
        // That generation does not exist yet.
      }
    }
    renameSync(file, path.join(options.directory, 'main.1.ndjson'));
  };

  return {
    log(level, event, module, safeContext) {
      const context =
        safeContext === undefined
          ? undefined
          : Object.fromEntries(
              Object.entries(safeContext).map(([key, value]) => [
                key,
                typeof value === 'string' ? redactUserPaths(value, profile) : value,
              ]),
            );
      const record = {
        timestamp: new Date().toISOString(),
        level,
        event,
        module,
        processId: process.pid,
        appVersion: options.appVersion,
        ...(context === undefined ? {} : { safeContext: context }),
      };
      try {
        rotateIfNeeded();
        appendFileSync(file, `${JSON.stringify(record)}\n`);
      } catch {
        // Logging must never take the app down.
      }
    },
  };
}
