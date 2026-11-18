import type {
  AppError,
  AssetId,
  CancellationToken,
  JobId,
  ProjectId,
  Result,
} from '@usee/contracts';
import type { ExportJob, ExportJobState, RenderJob, RenderPlan } from '@usee/domain';

export type ActiveExportState = Extract<ExportJobState, 'rendering' | 'validating' | 'publishing'>;

export interface ExportCoordinatorUpdate {
  readonly job: RenderJob;
  readonly error: AppError | null;
}

export interface PreparedExportJob {
  readonly job: ExportJob;
  readonly plan: RenderPlan;
  readonly planHash: string;
}

export interface PersistedExportJob {
  readonly prepared: PreparedExportJob;
  readonly update: ExportCoordinatorUpdate;
}

/** Durable snapshot port; adapters must replace a snapshot atomically. */
export interface ExportJobStorePort {
  load(): Promise<Result<readonly PersistedExportJob[]>>;
  save(entries: readonly PersistedExportJob[]): Promise<Result<void>>;
}

export interface ValidatedExportArtifact {
  readonly jobId: JobId;
  readonly destinationPath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

/** Publishes only a worker-validated job-owned artifact and never replaces an existing target. */
export interface ExportArtifactPublisherPort {
  publish(artifact: ValidatedExportArtifact): Promise<Result<void>>;
}

/** Resolves only the listed managed media IDs to main-process file paths. */
export interface ExportMediaPathResolverPort {
  resolve(
    projectId: ProjectId,
    assetIds: readonly AssetId[],
  ): Promise<Result<Readonly<Record<string, string>>>>;
}

/** Streams renderer-composed raw RGBA frames to the encoder with backpressure. */
export interface ExportFrameSourcePort {
  stream(
    job: ExportJob,
    plan: RenderPlan,
    cancellation: CancellationToken,
    writeFrame: (frame: Uint8Array, progress: number) => Promise<void>,
  ): Promise<Result<void>>;
}

export interface ExportWorkerPort {
  run(
    job: ExportJob,
    plan: RenderPlan,
    planHash: string,
    cancellation: CancellationToken,
    update: (state: ActiveExportState, progress: number) => void,
  ): Promise<Result<void>>;
}

export interface ExportCoordinatorPort {
  /** Load and reconcile durable jobs before exposing them to the UI. */
  initialize(): Promise<Result<void>>;
  enqueue(job: PreparedExportJob, cancellation?: CancellationToken): Promise<Result<RenderJob>>;
  /** `renderJobId` is the ID returned from enqueue, not `ExportJob.id`. */
  cancel(renderJobId: JobId): Promise<Result<void>>;
  get(renderJobId: JobId): Result<ExportCoordinatorUpdate>;
  /** Newest first; terminal history is bounded by the coordinator's retention limit. */
  list(): readonly ExportCoordinatorUpdate[];
  subscribe(listener: (update: ExportCoordinatorUpdate) => void): () => void;
}
