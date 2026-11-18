import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { asCorrelationId, asJobId } from '@usee/contracts';

import { createExportArtifactPublisher } from './export-artifact-publisher';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'export-artifact-publisher-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function publisher() {
  const workRoot = path.join(root, 'work');
  const jobDirectory = path.join(workRoot, 'job-1');
  await mkdir(jobDirectory, { recursive: true });
  const bytes = Buffer.from('validated mp4 bytes');
  await writeFile(path.join(jobDirectory, 'output.partial.mp4'), bytes);
  return {
    publish: createExportArtifactPublisher({
      workRoot,
      createCorrelationId: () => asCorrelationId('publisher-test'),
    }),
    artifact: {
      jobId: asJobId('job-1'),
      destinationPath: path.join(root, 'exports', 'output.mp4'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length,
    },
  };
}

describe('export artifact publisher', () => {
  it('publishes a verified artifact and preserves its job-owned source', async () => {
    const { publish, artifact } = await publisher();
    await mkdir(path.dirname(artifact.destinationPath));

    await expect(publish.publish(artifact)).resolves.toEqual({ ok: true, value: undefined });
    await expect(readFile(artifact.destinationPath, 'utf8')).resolves.toBe('validated mp4 bytes');
    await expect(
      readFile(path.join(root, 'work', 'job-1', 'output.partial.mp4'), 'utf8'),
    ).resolves.toBe('validated mp4 bytes');
  });

  it('never replaces a destination created after the export was queued', async () => {
    const { publish, artifact } = await publisher();
    await mkdir(path.dirname(artifact.destinationPath));
    await writeFile(artifact.destinationPath, 'keep this file');

    await expect(publish.publish(artifact)).resolves.toMatchObject({
      ok: false,
      error: { code: 'export.destination-exists' },
    });
    await expect(readFile(artifact.destinationPath, 'utf8')).resolves.toBe('keep this file');
  });
});
