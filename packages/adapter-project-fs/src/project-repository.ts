import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { OpenedProject, ProjectRepositoryPort, ProjectSummary } from '@usee/application';
import {
  createAppError,
  err,
  isOpaqueId,
  ok,
  type AssetId,
  type AppError,
  type CorrelationId,
  type PointerTrackDto,
  type ProjectId,
  type Result,
} from '@usee/contracts';
import { pointerTrackFromStream } from '@usee/domain';
import {
  decodeManifest,
  decodePictureChanges,
  decodeWaveform,
  encodeManifest,
  MANIFEST_CHECKPOINT_PATH,
  MANIFEST_FILE_NAME,
  PROJECT_BUNDLE_EXTENSION,
  decodePointerStream,
  isSafeRelativePath,
  pictureChangesFileSchema,
  pictureChangesPath,
  readManifest,
  THUMBNAIL_PATH,
  waveformPath,
  type ManifestReadFailure,
  type ProjectManifest,
} from '@usee/project-format';

import { writeFileAtomic } from './file-operations';

// Manifests are small; this only bounds a damaged or hostile file.
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
// Ten hours of peaks, base64-encoded, with room for the provenance fields.
const MAX_WAVEFORM_BYTES = 8 * 1024 * 1024;
/** Only the newest projects' thumbnails go in the list, so it stays small. */
const LISTED_THUMBNAILS = 50;
const MAX_THUMBNAIL_BYTES = 120_000;
/** 100 000 changes, the most a file may hold, fit well within this. */
const MAX_PICTURE_CHANGES_BYTES = 16 * 1024 * 1024;
// Several hours of continuous pointer movement.
const MAX_POINTER_STREAM_BYTES = 256 * 1024 * 1024;

/** A typed array's bytes as base64 (little-endian on every platform Electron ships). */
function packed(values: Float32Array | Float64Array): string {
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString('base64');
}

export interface ProjectRepositoryOptions {
  /** The folder recordings are saved to; `list` reads only this one. */
  readonly projectsRoot: string;
  readonly createCorrelationId: () => CorrelationId;
}

class RepositoryError extends Error {
  constructor(
    readonly category: 'project' | 'storage',
    readonly code: string,
  ) {
    super(code);
  }
}

/** A JPEG's start-of-image marker, within the size a thumbnail may be. */
function isJpeg(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 3 &&
    bytes.byteLength <= MAX_THUMBNAIL_BYTES &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  );
}

function errnoOf(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

function readFailure(failure: ManifestReadFailure): RepositoryError {
  switch (failure.reason) {
    case 'version-newer':
      return new RepositoryError('project', 'project.version-newer');
    case 'migration-missing':
    case 'migration-failed':
      return new RepositoryError('project', 'project.migration-failed');
    case 'version-missing':
    case 'invalid':
      return new RepositoryError('project', 'project.manifest-invalid');
  }
}

function bundlePath(projectPath: string, relativePath: string): string {
  return path.join(projectPath, ...relativePath.split('/'));
}

function insideDirectory(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Keeps the manifest as it was before a migration, then writes the migrated
 * one atomically (docs/project-format.md, "Versioning and migrations").
 */
export async function persistMigration(
  projectPath: string,
  originalText: string,
  migrated: ProjectManifest,
  fromVersion: number,
): Promise<void> {
  const backup = bundlePath(projectPath, `recovery/checkpoints/manifest-v${fromVersion}.json`);
  await mkdir(path.dirname(backup), { recursive: true });
  await writeFileAtomic(backup, originalText);
  const encoded = encodeManifest(migrated);
  if (!encoded.ok) {
    throw new RepositoryError('project', 'project.migration-failed');
  }
  await writeFileAtomic(path.join(projectPath, MANIFEST_FILE_NAME), encoded.value);
}

/**
 * Project bundles directly inside the projects folder. A save validates the
 * new manifest, keeps the one it replaces as the recovery checkpoint, and
 * renames the new one into place, so `manifest.json` is always complete.
 */
export function createProjectRepository(options: ProjectRepositoryOptions): ProjectRepositoryPort {
  function toAppError(error: unknown): AppError {
    const errno = errnoOf(error);
    let category: 'project' | 'storage' = 'storage';
    let code = 'storage.io-failed';
    if (error instanceof RepositoryError) {
      ({ category, code } = error);
    } else if (errno === 'ENOENT' || errno === 'ENOTDIR') {
      category = 'project';
      code = 'project.not-found';
    } else if (errno === 'ENOSPC') {
      code = 'storage.disk-full';
    } else if (errno === 'EACCES' || errno === 'EPERM') {
      code = 'storage.access-denied';
    }
    return createAppError({
      category,
      code,
      retryable: code === 'storage.disk-full',
      userMessageKey: `errors.${code}`,
      correlationId: options.createCorrelationId(),
      ...(errno === undefined ? {} : { diagnosticContext: { errno } }),
    });
  }

  /** A project's thumbnail as a data URL, or undefined when it has none or it is not a small JPEG. */
  async function readThumbnail(projectPath: string): Promise<string | undefined> {
    try {
      const file = path.join(projectPath, ...THUMBNAIL_PATH.split('/'));
      if ((await stat(file)).size > MAX_THUMBNAIL_BYTES) {
        return undefined;
      }
      const bytes = await readFile(file);
      return isJpeg(bytes) ? `data:image/jpeg;base64,${bytes.toString('base64')}` : undefined;
    } catch {
      return undefined; // derived and disposable: the list shows a placeholder
    }
  }

  /** A recording's picture changes and the SHA-256 of their file; null when missing or invalid. */
  async function readPictureFile(requestedPath: string, assetId: string) {
    if (!isOpaqueId(assetId)) {
      return null; // an asset ID never names a path
    }
    const file = bundlePath(await resolveBundle(requestedPath), pictureChangesPath(assetId));
    let bytes: Buffer;
    try {
      if ((await stat(file)).size > MAX_PICTURE_CHANGES_BYTES) {
        return null;
      }
      bytes = await readFile(file);
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') {
        return null;
      }
      throw error;
    }
    // Derived and disposable: a damaged file is read again by the editor.
    const decoded = decodePictureChanges(bytes.toString('utf8'));
    return decoded.ok
      ? { file: decoded.value, sha256: createHash('sha256').update(bytes).digest('hex') }
      : null;
  }

  async function guard<Value>(operation: () => Promise<Value>): Promise<Result<Value>> {
    try {
      return ok(await operation());
    } catch (error) {
      return err(toAppError(error));
    }
  }

  /**
   * A bundle directly inside the projects folder, by its canonical path. Other
   * locations are refused: the renderer names projects by path, and must not
   * be able to open just any folder.
   */
  async function resolveBundle(projectPath: string): Promise<string> {
    if (!path.isAbsolute(projectPath)) {
      throw new RepositoryError('project', 'project.outside-projects-folder');
    }
    const [root, real] = await Promise.all([realpath(options.projectsRoot), realpath(projectPath)]);
    const relative = path.relative(root, real);
    if (
      relative === '' ||
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      relative.includes(path.sep) ||
      !relative.endsWith(PROJECT_BUNDLE_EXTENSION)
    ) {
      throw new RepositoryError('project', 'project.outside-projects-folder');
    }
    return real;
  }

  async function readManifestText(projectPath: string): Promise<string> {
    const file = path.join(projectPath, MANIFEST_FILE_NAME);
    if ((await stat(file)).size > MAX_MANIFEST_BYTES) {
      throw new RepositoryError('project', 'project.manifest-invalid');
    }
    return readFile(file, 'utf8');
  }

  async function resolveManagedFile(projectPath: string, relativePath: string): Promise<string> {
    if (!isSafeRelativePath(relativePath)) {
      throw new RepositoryError('project', 'project.asset-not-found');
    }
    try {
      const root = await realpath(projectPath);
      let filePath = root;
      const segments = relativePath.split('/');
      for (const [index, segment] of segments.entries()) {
        filePath = path.join(filePath, segment);
        const info = await lstat(filePath);
        if (
          info.isSymbolicLink() ||
          (index < segments.length - 1 && !info.isDirectory()) ||
          (index === segments.length - 1 && !info.isFile())
        ) {
          throw new RepositoryError('project', 'project.asset-not-found');
        }
      }
      const resolvedPath = await realpath(filePath);
      if (!insideDirectory(root, resolvedPath)) {
        throw new RepositoryError('project', 'project.asset-not-found');
      }
      return resolvedPath;
    } catch (error) {
      if (errnoOf(error) === 'ENOENT' || errnoOf(error) === 'ENOTDIR') {
        throw new RepositoryError('project', 'project.asset-not-found');
      }
      throw error;
    }
  }

  async function findProject(projectId: ProjectId): Promise<{
    readonly path: string;
    readonly project: ProjectManifest['project'];
  }> {
    let entries;
    try {
      entries = await readdir(options.projectsRoot, { withFileTypes: true });
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') {
        throw new RepositoryError('project', 'project.not-found');
      }
      throw error;
    }
    let matchingProject:
      { readonly path: string; readonly project: ProjectManifest['project'] } | undefined;
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.endsWith(PROJECT_BUNDLE_EXTENSION)) {
        continue;
      }
      const projectPath = await resolveBundle(path.join(options.projectsRoot, entry.name));
      let manifest;
      try {
        manifest = decodeManifest(await readManifestText(projectPath));
      } catch {
        continue;
      }
      if (!manifest.ok || manifest.value.project.id !== projectId) {
        continue;
      }
      if (matchingProject !== undefined) {
        throw new RepositoryError('project', 'project.manifest-invalid');
      }
      matchingProject = { path: projectPath, project: manifest.value.project };
    }
    if (matchingProject === undefined) {
      throw new RepositoryError('project', 'project.not-found');
    }
    return matchingProject;
  }

  /** A pointer stream file's bytes, or null when the path is unsafe, the file missing or too large. */
  async function readPointerBytes(
    requestedPath: string,
    relativePath: string,
  ): Promise<Buffer | null> {
    if (!isSafeRelativePath(relativePath)) {
      return null;
    }
    let file: string;
    try {
      const projectPath = await resolveBundle(requestedPath);
      file = await resolveManagedFile(projectPath, relativePath);
      if ((await stat(file)).size > MAX_POINTER_STREAM_BYTES) {
        return null;
      }
      return await readFile(file);
    } catch (error) {
      if (
        errnoOf(error) === 'ENOENT' ||
        (error instanceof RepositoryError && error.code === 'project.asset-not-found')
      ) {
        return null;
      }
      throw error;
    }
  }

  return {
    list() {
      return guard(async () => {
        let entries;
        try {
          entries = await readdir(options.projectsRoot, { withFileTypes: true });
        } catch (error) {
          if (errnoOf(error) === 'ENOENT') {
            return [];
          }
          throw error;
        }
        const projects: ProjectSummary[] = [];
        for (const entry of entries) {
          if (!entry.isDirectory() || !entry.name.endsWith(PROJECT_BUNDLE_EXTENSION)) {
            continue;
          }
          const projectPath = path.join(options.projectsRoot, entry.name);
          let text: string;
          let modified: Date;
          try {
            modified = (await stat(path.join(projectPath, MANIFEST_FILE_NAME))).mtime;
            text = await readManifestText(projectPath);
          } catch {
            continue; // no manifest: not a project, or an import still in progress
          }
          const read = readManifest(text);
          projects.push({
            projectPath,
            title: read.ok
              ? read.value.manifest.project.title
              : path.basename(entry.name, PROJECT_BUNDLE_EXTENSION),
            modifiedAt: modified.toISOString(),
          });
        }
        projects.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
        return Promise.all(
          projects.map(async (project, index) => {
            const thumbnail =
              index < LISTED_THUMBNAILS ? await readThumbnail(project.projectPath) : undefined;
            return thumbnail === undefined ? project : { ...project, thumbnail };
          }),
        );
      });
    },

    writeThumbnail(requestedPath, jpeg) {
      return guard(async () => {
        if (!isJpeg(jpeg)) {
          throw new Error('A thumbnail is a small JPEG.');
        }
        const file = bundlePath(await resolveBundle(requestedPath), THUMBNAIL_PATH);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFileAtomic(file, jpeg);
      });
    },

    open(requestedPath) {
      return guard(async (): Promise<OpenedProject> => {
        const projectPath = await resolveBundle(requestedPath);
        const text = await readManifestText(projectPath);
        const read = readManifest(text);
        if (!read.ok) {
          throw readFailure(read.error);
        }
        const { manifest, migratedFrom } = read.value;
        if (migratedFrom !== null) {
          await persistMigration(projectPath, text, manifest, migratedFrom);
        }
        return { project: manifest.project, migratedFrom };
      });
    },

    resolveMediaAssets(projectId: ProjectId, assetIds: readonly AssetId[]) {
      return guard(async () => {
        if (!isOpaqueId(projectId) || assetIds.some((assetId) => !isOpaqueId(assetId))) {
          throw new RepositoryError('project', 'project.asset-not-found');
        }
        if (assetIds.length === 0) {
          return {};
        }
        const matchingProject = await findProject(projectId);
        const paths: Record<string, string> = {};
        for (const assetId of new Set(assetIds)) {
          const asset = matchingProject.project.assets.find(
            (candidate) => candidate.id === assetId,
          );
          if (asset === undefined || asset.kind === 'event') {
            throw new RepositoryError('project', 'project.asset-not-found');
          }
          paths[assetId] = await resolveManagedFile(matchingProject.path, asset.relativePath);
        }
        return paths;
      });
    },

    readPointerTrackById(projectId, streamAssetId) {
      return guard(async (): Promise<PointerTrackDto | null> => {
        if (!isOpaqueId(projectId) || !isOpaqueId(streamAssetId)) {
          throw new RepositoryError('project', 'project.asset-not-found');
        }
        const matchingProject = await findProject(projectId);
        const asset = matchingProject.project.assets.find(
          (candidate) => candidate.id === streamAssetId && candidate.kind === 'event',
        );
        if (asset === undefined) {
          throw new RepositoryError('project', 'project.asset-not-found');
        }
        const bytes = await readPointerBytes(matchingProject.path, asset.relativePath);
        const decoded = bytes === null ? undefined : decodePointerStream(bytes.toString('utf8'));
        if (decoded === undefined || !decoded.ok) {
          return null;
        }
        const track = pointerTrackFromStream(decoded.value.stream);
        return {
          display: track.display,
          moveTimes: packed(track.moveTimes),
          moveXs: packed(track.moveXs),
          moveYs: packed(track.moveYs),
          clicks: track.clicks,
          shapes: track.shapes,
          visibility: track.visibility,
        };
      });
    },

    save(requestedPath, project) {
      return guard(async () => {
        const projectPath = await resolveBundle(requestedPath);
        const text = await readManifestText(projectPath);
        const current = decodeManifest(text);
        if (!current.ok) {
          throw new RepositoryError('project', 'project.manifest-invalid');
        }
        const next: ProjectManifest = {
          ...current.value,
          project,
          managedAssetPaths: Object.fromEntries(
            project.assets.map((asset) => [asset.id, asset.relativePath]),
          ),
        };
        const encoded = encodeManifest(next);
        // Never write a manifest this build could not open again.
        if (!encoded.ok || !decodeManifest(encoded.value).ok) {
          throw new RepositoryError('project', 'project.invalid');
        }
        const checkpoint = bundlePath(projectPath, MANIFEST_CHECKPOINT_PATH);
        await mkdir(path.dirname(checkpoint), { recursive: true });
        await writeFileAtomic(checkpoint, text);
        await writeFileAtomic(path.join(projectPath, MANIFEST_FILE_NAME), encoded.value);
      });
    },

    readWaveform(requestedPath, assetId) {
      return guard(async () => {
        if (!isOpaqueId(assetId)) {
          return null; // an asset ID never names a path
        }
        const file = bundlePath(await resolveBundle(requestedPath), waveformPath(assetId));
        let text: string;
        try {
          if ((await stat(file)).size > MAX_WAVEFORM_BYTES) {
            return null;
          }
          text = await readFile(file, 'utf8');
        } catch (error) {
          if (errnoOf(error) === 'ENOENT') {
            return null;
          }
          throw error;
        }
        // Derived and disposable: a damaged file just means no peaks.
        const waveform = decodeWaveform(text);
        return waveform.ok
          ? { peaksPerSecond: waveform.value.peaksPerSecond, peaks: waveform.value.peaks }
          : null;
      });
    },

    readPictureChanges(requestedPath, assetId) {
      return guard(async () => {
        const read = await readPictureFile(requestedPath, assetId);
        return read === null ? null : { changes: read.file.changes, sha256: read.sha256 };
      });
    },

    readPictureAnalysis(requestedPath, assetId) {
      return guard(async () => {
        const read = await readPictureFile(requestedPath, assetId);
        return read === null
          ? null
          : {
              algorithm: read.file.algorithm,
              sampleIntervalUs: read.file.sampleIntervalUs,
              changes: read.file.changes,
            };
      });
    },

    writePictureChanges(requestedPath, assetId, analysis, producer) {
      return guard(async () => {
        if (!isOpaqueId(assetId)) {
          throw new Error('An asset ID never names a path.');
        }
        const contents = pictureChangesFileSchema.parse({
          format: 'usee.picture-changes',
          version: 1,
          producer,
          algorithm: analysis.algorithm,
          sampleIntervalUs: analysis.sampleIntervalUs,
          generatedAt: new Date().toISOString(),
          changes: analysis.changes,
        });
        const file = bundlePath(await resolveBundle(requestedPath), pictureChangesPath(assetId));
        await mkdir(path.dirname(file), { recursive: true });
        await writeFileAtomic(file, `${JSON.stringify(contents)}\n`);
      });
    },

    readPointerStream(requestedPath, relativePath) {
      return guard(async () => {
        const bytes = await readPointerBytes(requestedPath, relativePath);
        const decoded = bytes === null ? undefined : decodePointerStream(bytes.toString('utf8'));
        return bytes === null || decoded === undefined || !decoded.ok
          ? null
          : {
              stream: decoded.value.stream,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            };
      });
    },

    readPointerTrack(requestedPath, relativePath) {
      return guard(async (): Promise<PointerTrackDto | null> => {
        const bytes = await readPointerBytes(requestedPath, relativePath);
        const decoded = bytes === null ? undefined : decodePointerStream(bytes.toString('utf8'));
        if (decoded === undefined || !decoded.ok) {
          return null;
        }
        const track = pointerTrackFromStream(decoded.value.stream);
        return {
          display: track.display,
          moveTimes: packed(track.moveTimes),
          moveXs: packed(track.moveXs),
          moveYs: packed(track.moveYs),
          clicks: track.clicks,
          shapes: track.shapes,
          visibility: track.visibility,
        };
      });
    },
  };
}
