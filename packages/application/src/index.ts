/**
 * Application ports and services. Concrete adapters implement the ports;
 * only composition roots instantiate them.
 */

export const APPLICATION_API_VERSION = 1 as const;

export type { ApplicationEvent } from './events';
export { ExportCoordinator } from './export-coordinator';
export type { ExportCoordinatorDependencies } from './export-coordinator';
export { prepareExportJob } from './export-preparation';
export type { RenderPlanHasher } from './export-preparation';
export type {
  ActiveExportState,
  ExportArtifactPublisherPort,
  ExportCoordinatorPort,
  ExportCoordinatorUpdate,
  ExportFrameSourcePort,
  ExportJobStorePort,
  ExportMediaPathResolverPort,
  PersistedExportJob,
  PreparedExportJob,
  ValidatedExportArtifact,
  ExportWorkerPort,
} from './export-ports';
export type {
  OpenedProject,
  ProjectRepositoryPort,
  ProjectSummary,
  WaveformPeaks,
} from './project-ports';
export type {
  ProjectSaveState,
  ProjectSessionDependencies,
  ProjectSessionState,
} from './project-session';
export { ProjectSession } from './project-session';
export { toProjectSnapshot } from './project-snapshot';
export { compileRenderPlan } from './render-plan';
export type { RenderPlanErrorCode } from './render-plan';
export type { RecorderHostEvent, RecorderHostPort } from './recorder-host-port';
export type { RecordingServiceDependencies } from './recording-service';
export { RecordingService } from './recording-service';
export type { ImportedRecording, RecordingStorePort } from './recording-store-port';
export type { UseCase } from './use-case';
export type {
  AnalysisInputPort,
  CameraAnalysisOptions,
  FocusContext,
  FocusStrategy,
  PictureChangesInput,
  PointerStreamInput,
} from './camera-analysis';
export {
  clickFocusStrategy,
  pointerFocusStrategy,
  pointerPictureFocusStrategy,
  staleCameraRuns,
} from './camera-analysis';
