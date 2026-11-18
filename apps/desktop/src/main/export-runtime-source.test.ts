import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveExportRuntimeSource } from './export-runtime-source';
import { TRUSTED_FFMPEG_MANIFEST_SHA256 } from './ffmpeg-runtime-trust';

const appPath = path.join('D:', 'usee', 'apps', 'desktop');
const resourcesPath = path.join('C:', 'Program Files', 'usee', 'resources');

describe('the export runtime source', () => {
  it('ships only its own resources, trusted by the release anchor', () => {
    expect(resolveExportRuntimeSource({ isPackaged: true, appPath, resourcesPath })).toEqual({
      resourcesDirectory: resourcesPath,
      manifestFileName: 'runtime-manifest.json',
      trust: { kind: 'anchor', sha256: TRUSTED_FFMPEG_MANIFEST_SHA256 },
    });
  });

  it('takes the repository build and its development manifest only when unpackaged', () => {
    expect(resolveExportRuntimeSource({ isPackaged: false, appPath, resourcesPath })).toEqual({
      resourcesDirectory: path.join('D:', 'usee', 'build', 'ffmpeg', 'resources'),
      manifestFileName: 'development-manifest.json',
      trust: { kind: 'development' },
    });
  });
});
