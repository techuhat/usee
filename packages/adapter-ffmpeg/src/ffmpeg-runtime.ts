import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  createAppError,
  err,
  ffmpegRuntimeManifestSchema,
  ok,
  type AppError,
  type CorrelationId,
  type FfmpegRuntimeManifest,
  type Result,
} from '@usee/contracts';

export interface VerifiedFfmpegRuntime {
  /** Main-process only. Never serialize this path over renderer IPC. */
  readonly executablePath: string;
  readonly manifest: FfmpegRuntimeManifest;
}

type RuntimeErrorCode =
  | 'export.ffmpeg-manifest-untrusted'
  | 'export.ffmpeg-manifest-invalid'
  | 'export.ffmpeg-runtime-missing'
  | 'export.ffmpeg-runtime-unsafe'
  | 'export.ffmpeg-checksum-mismatch';

function failure(code: RuntimeErrorCode, correlationId: CorrelationId): Result<never> {
  const error: AppError = createAppError({
    category: 'export',
    code,
    retryable: false,
    userMessageKey: `errors.${code}`,
    correlationId,
  });
  return err(error);
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

/**
 * Verifies bytes read from the fixed packaged manifest and executable. The
 * manifest hash is a build-time trust anchor passed by the packaging config.
 */
export async function verifyFfmpegRuntime(
  resourcesDirectory: string,
  manifestBytes: Uint8Array,
  trustedManifestSha256: string,
  correlationId: CorrelationId,
): Promise<Result<VerifiedFfmpegRuntime>> {
  const manifestHash = createHash('sha256').update(manifestBytes).digest('hex');
  if (!/^[0-9a-f]{64}$/.test(trustedManifestSha256) || manifestHash !== trustedManifestSha256) {
    return failure('export.ffmpeg-manifest-untrusted', correlationId);
  }

  let decodedManifest: unknown;
  try {
    decodedManifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8'));
  } catch {
    return failure('export.ffmpeg-manifest-invalid', correlationId);
  }
  const parsedManifest = ffmpegRuntimeManifestSchema.safeParse(decodedManifest);
  if (!parsedManifest.success) {
    return failure('export.ffmpeg-manifest-invalid', correlationId);
  }

  try {
    const resourcesRoot = await realpath(resourcesDirectory);
    const ffmpegDirectory = path.join(resourcesRoot, 'ffmpeg');
    const binaryEntry = path.join(ffmpegDirectory, parsedManifest.data.binaryName);
    if (
      (await lstat(ffmpegDirectory)).isSymbolicLink() ||
      (await lstat(binaryEntry)).isSymbolicLink()
    ) {
      return failure('export.ffmpeg-runtime-unsafe', correlationId);
    }
    const executablePath = await realpath(binaryEntry);
    if (!isInside(resourcesRoot, executablePath)) {
      return failure('export.ffmpeg-runtime-unsafe', correlationId);
    }
    const binaryInfo = await stat(executablePath);
    if (!binaryInfo.isFile() || binaryInfo.size === 0 || binaryInfo.size > 512 * 1024 * 1024) {
      return failure('export.ffmpeg-runtime-unsafe', correlationId);
    }
    if ((await sha256File(executablePath)) !== parsedManifest.data.sha256) {
      return failure('export.ffmpeg-checksum-mismatch', correlationId);
    }
    return ok({ executablePath, manifest: parsedManifest.data });
  } catch (cause) {
    const code =
      cause !== null && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT'
        ? 'export.ffmpeg-runtime-missing'
        : 'export.ffmpeg-runtime-unsafe';
    return failure(code, correlationId);
  }
}
