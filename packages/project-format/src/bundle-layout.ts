/** A project is a directory with this suffix (ADR-004). */
export const PROJECT_BUNDLE_EXTENSION = '.screenproj';

/** The canonical, versioned semantic project document at the bundle root. */
export const MANIFEST_FILE_NAME = 'manifest.json';

/** Append-only recovery journal, relative to the bundle root. */
export const RECOVERY_JOURNAL_PATH = 'recovery/journal.ndjson';

/** The manifest as it stood before the latest save: the recovery checkpoint. */
export const MANIFEST_CHECKPOINT_PATH = 'recovery/checkpoints/manifest.json';

/**
 * Directories inside a bundle (docs/project-format.md). `cache` and the
 * `derived/*` and `media/proxies` trees are rebuildable and may be omitted
 * from a portable copy.
 */
export const PROJECT_BUNDLE_DIRECTORIES = [
  'media/originals',
  'media/proxies',
  'metadata/sessions',
  'metadata/interactions',
  'derived/analysis',
  'derived/waveforms',
  'derived/thumbnails',
  'cache',
  'renders',
  'recovery/checkpoints',
] as const;

export type ProjectBundleDirectory = (typeof PROJECT_BUNDLE_DIRECTORIES)[number];
