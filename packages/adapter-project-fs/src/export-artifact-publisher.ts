import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { constants, copyFile, link, lstat, open, realpath, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

import type { ExportArtifactPublisherPort, ValidatedExportArtifact } from '@usee/application';
import { createAppError, err, ok, type CorrelationId } from '@usee/contracts';

export interface ExportArtifactPublisherOptions {
  /** Private root containing one job directory per opaque job ID. */
  readonly workRoot: string;
  readonly createCorrelationId: () => CorrelationId;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Copies a validated job artifact beside its destination and atomically publishes without replacement. */
export function createExportArtifactPublisher(
  options: ExportArtifactPublisherOptions,
): ExportArtifactPublisherPort {
  const failure = (
    code: 'export.artifact-invalid' | 'export.publish-failed' | 'export.destination-exists',
  ) =>
    err(
      createAppError({
        category: 'export',
        code,
        retryable: code === 'export.publish-failed',
        userMessageKey: `errors.${code}`,
        correlationId: options.createCorrelationId(),
      }),
    );

  return {
    async publish(artifact: ValidatedExportArtifact) {
      if (
        !path.isAbsolute(artifact.destinationPath) ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(artifact.jobId) ||
        !/^[0-9a-f]{64}$/.test(artifact.sha256) ||
        !Number.isSafeInteger(artifact.sizeBytes) ||
        artifact.sizeBytes <= 0
      ) {
        return failure('export.artifact-invalid');
      }

      let partialPath: string | undefined;
      try {
        const workRoot = await realpath(options.workRoot);
        const jobDirectory = path.join(workRoot, artifact.jobId);
        const jobInfo = await lstat(jobDirectory);
        if (!jobInfo.isDirectory() || jobInfo.isSymbolicLink()) {
          return failure('export.artifact-invalid');
        }
        const realJobDirectory = await realpath(jobDirectory);
        if (!isInside(workRoot, realJobDirectory)) {
          return failure('export.artifact-invalid');
        }

        const sourcePath = path.join(realJobDirectory, 'output.partial.mp4');
        const sourceInfo = await lstat(sourcePath);
        if (
          !sourceInfo.isFile() ||
          sourceInfo.isSymbolicLink() ||
          sourceInfo.size !== artifact.sizeBytes ||
          (await sha256File(sourcePath)) !== artifact.sha256
        ) {
          return failure('export.artifact-invalid');
        }

        const destinationPath = path.resolve(artifact.destinationPath);
        const destinationDirectory = path.dirname(destinationPath);
        const destinationDirectoryInfo = await stat(destinationDirectory);
        if (!destinationDirectoryInfo.isDirectory()) {
          return failure('export.publish-failed');
        }
        partialPath = path.join(
          destinationDirectory,
          `.${path.basename(destinationPath)}.${artifact.jobId}.${randomBytes(6).toString('hex')}.partial`,
        );
        await copyFile(sourcePath, partialPath, constants.COPYFILE_EXCL);

        const stagedInfo = await stat(partialPath);
        if (
          stagedInfo.size !== artifact.sizeBytes ||
          (await sha256File(partialPath)) !== artifact.sha256
        ) {
          return failure('export.artifact-invalid');
        }

        const stagedHandle = await open(partialPath, 'r+');
        try {
          await stagedHandle.sync();
        } finally {
          await stagedHandle.close();
        }
        // `link` creates the final name atomically and fails with EEXIST. Unlike
        // rename, it cannot replace a file created after the save dialog closed.
        await link(partialPath, destinationPath);
        await unlink(partialPath)
          .then(() => {
            partialPath = undefined;
          })
          .catch(() => undefined);
        return ok(undefined);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
          return failure('export.destination-exists');
        }
        return failure('export.publish-failed');
      } finally {
        if (partialPath !== undefined) {
          await unlink(partialPath).catch(() => undefined);
        }
      }
    },
  };
}
