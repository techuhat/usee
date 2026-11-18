/**
 * The persisted-project boundary. Parsing, migration execution and filesystem
 * access are supplied by adapters; this package fixes the durable contract.
 */

export type { ProjectBundleDirectory } from './bundle-layout';
export {
  MANIFEST_FILE_NAME,
  PROJECT_BUNDLE_DIRECTORIES,
  MANIFEST_CHECKPOINT_PATH,
  PROJECT_BUNDLE_EXTENSION,
  RECOVERY_JOURNAL_PATH,
} from './bundle-layout';
export { PROJECT_FORMAT_VERSION } from './format-version';
export type { ProjectDocument, ProjectManifest } from './manifest';
export type { ManifestReadFailure, ReadManifestResult } from './manifest-schema';
export {
  decodeManifest,
  encodeManifest,
  projectManifestSchema,
  readManifest,
} from './manifest-schema';
export type {
  JsonObject,
  MigratedManifest,
  MigrationFailure,
  ProjectMigration,
} from './migrations';
export { migrateManifest, PROJECT_MIGRATIONS } from './migrations';
export type { ProjectFormatCodec, ProjectFormatRepositoryPort } from './ports';
export type { DecodedPointerStream } from './pointer-stream';
export { decodePointerStream, pointerStreamPath } from './pointer-stream';
export type {
  RecordedSource,
  RecordingMedia,
  RecordingProjectInput,
  RecordingProjectLooks,
} from './recording-project';
export {
  createRecordingProject,
  recordingAssetId,
  sessionMediaDirectory,
} from './recording-project';
export { isSafeRelativePath } from './relative-path';
export type { WaveformFile } from './waveform';
export { decodeWaveform, waveformFileSchema, waveformPath } from './waveform';
export type { PictureChangesFile } from './picture-changes';
/** Bundle-relative path of the project's thumbnail for the project list (derived, disposable). */
export const THUMBNAIL_PATH = 'derived/thumbnail.jpg';
export {
  decodePictureChanges,
  pictureChangesFileSchema,
  pictureChangesPath,
} from './picture-changes';
