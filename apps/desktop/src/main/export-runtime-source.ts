import path from 'node:path';

import { TRUSTED_FFMPEG_MANIFEST_SHA256 } from './ffmpeg-runtime-trust';

/** Where the export runtime comes from, and what vouches for its manifest. */
export interface ExportRuntimeSource {
  /** Holds ffmpeg/<binary> and ffmpeg/<manifestFileName>, as a packaged app's resources do. */
  readonly resourcesDirectory: string;
  readonly manifestFileName: string;
  /**
   * A release trusts its manifest only by the SHA-256 set at build time. An
   * unpackaged development build takes the manifest scripts/build-ffmpeg.mjs
   * wrote beside the binary as it is, as it runs the recorder host from its
   * build folder unverified: the manifest still has to match the binary.
   */
  readonly trust:
    { readonly kind: 'anchor'; readonly sha256: string } | { readonly kind: 'development' };
}

export interface ExportRuntimeSourceInput {
  readonly isPackaged: boolean;
  /** `app.getAppPath()`: apps/desktop when unpackaged. */
  readonly appPath: string;
  readonly resourcesPath: string;
}

/**
 * A shipped app's runtime is its own resources/ffmpeg with the release's
 * manifest and trust anchor, never anything else; only an unpackaged build
 * uses the repository's `npm run build:ffmpeg` output and its development
 * manifest, which names no legal review.
 */
export function resolveExportRuntimeSource(input: ExportRuntimeSourceInput): ExportRuntimeSource {
  if (input.isPackaged) {
    return {
      resourcesDirectory: input.resourcesPath,
      manifestFileName: 'runtime-manifest.json',
      trust: { kind: 'anchor', sha256: TRUSTED_FFMPEG_MANIFEST_SHA256 },
    };
  }
  return {
    resourcesDirectory: path.join(input.appPath, '..', '..', 'build', 'ffmpeg', 'resources'),
    manifestFileName: 'development-manifest.json',
    trust: { kind: 'development' },
  };
}
