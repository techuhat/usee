import { mkdir, lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ExportJobStorePort, PersistedExportJob } from '@usee/application';
import {
  createAppError,
  err,
  ok,
  exportQueueSnapshotSchema,
  type CorrelationId,
} from '@usee/contracts';

import { writeFileAtomic } from './file-operations';

const MAX_QUEUE_BYTES = 64 * 1024 * 1024;
const validateSnapshot = exportQueueSnapshotSchema as unknown as {
  safeParse(
    value: unknown,
  ): { readonly success: true; readonly data: unknown } | { readonly success: false };
};

export interface ExportJobStoreOptions {
  /** Exact file under the desktop application's private user-data directory. */
  readonly filePath: string;
  readonly createCorrelationId: () => CorrelationId;
}

/** Stores path-free prepared jobs in one validated, atomically replaced snapshot. */
export function createExportJobStore(options: ExportJobStoreOptions): ExportJobStorePort {
  const failure = (code: string) =>
    err(
      createAppError({
        category: 'storage',
        code: `storage.${code}`,
        retryable: code === 'export-queue-read-failed' || code === 'export-queue-write-failed',
        userMessageKey: `errors.storage.${code}`,
        correlationId: options.createCorrelationId(),
      }),
    );

  return {
    async load() {
      try {
        const info = await lstat(options.filePath);
        if (!info.isFile() || info.size > MAX_QUEUE_BYTES) {
          return failure('export-queue-invalid');
        }
        const contents = await readFile(options.filePath, 'utf8');
        if (Buffer.byteLength(contents, 'utf8') > MAX_QUEUE_BYTES) {
          return failure('export-queue-invalid');
        }
        const decoded: unknown = JSON.parse(contents);
        const parsed = validateSnapshot.safeParse(decoded);
        if (!parsed.success) {
          return failure('export-queue-invalid');
        }
        const data = parsed.data as {
          readonly entries: readonly PersistedExportJob[];
        };
        return ok(data.entries);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return ok([]);
        }
        return failure('export-queue-read-failed');
      }
    },
    async save(entries) {
      const parsed = validateSnapshot.safeParse({ formatVersion: 1, entries });
      if (!parsed.success) {
        return failure('export-queue-invalid');
      }
      const contents = `${JSON.stringify(parsed.data)}\n`;
      if (Buffer.byteLength(contents, 'utf8') > MAX_QUEUE_BYTES) {
        return failure('export-queue-too-large');
      }
      try {
        await mkdir(path.dirname(options.filePath), { recursive: true });
        await writeFileAtomic(options.filePath, contents);
        return ok(undefined);
      } catch {
        return failure('export-queue-write-failed');
      }
    },
  };
}
