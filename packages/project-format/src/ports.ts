import type { Result } from '@usee/contracts';

import type { ProjectDocument, ProjectManifest } from './manifest';

export interface ProjectFormatCodec {
  decode(serializedManifest: string): Result<ProjectManifest>;
  encode(manifest: ProjectManifest): Result<string>;
}

/** Implemented by a filesystem adapter; this package performs no I/O. */
export interface ProjectFormatRepositoryPort {
  read(projectRoot: string): Promise<Result<ProjectDocument>>;
  write(document: ProjectDocument): Promise<Result<void>>;
  recover(projectRoot: string): Promise<Result<ProjectDocument>>;
}
