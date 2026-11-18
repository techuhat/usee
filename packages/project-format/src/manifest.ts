import type { JsonValue, SchemaVersion } from '@usee/contracts';
import type { Project } from '@usee/domain';

/**
 * `manifest.json`. `manifestVersion` is required; readers fail closed on an
 * unknown mandatory version (docs/project-format.md).
 */
export interface ProjectManifest {
  readonly manifestVersion: SchemaVersion;
  readonly project: Project;
  /** Asset ID → bundle-relative path, normalized and confined to the bundle. */
  readonly managedAssetPaths: Readonly<Record<string, string>>;
  readonly metadata: Readonly<Record<string, JsonValue>>;
}

export interface ProjectDocument {
  readonly manifest: ProjectManifest;
  readonly rootDirectory: string;
}
