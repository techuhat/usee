import type { PointerTrackDto } from './pointer';
import type {
  ExportFrameContextDto,
  ExportFrameRequestDto,
  ExportJobReferenceDto,
  ExportJobStatusDto,
  ExportQueueViewDto,
  ExportRenderJobReferenceDto,
  QueueExportRequestDto,
  SubmitExportFrameRequestDto,
} from './desktop-export';
import type {
  AssetReference,
  EditProjectRequest,
  ProjectReference,
  ProjectSnapshot,
  ProjectSummary,
  SaveProjectThumbnailRequest,
  Waveform,
  WaveformRequest,
} from './project';
import type {
  ChooseRegionRequest,
  ChosenRegion,
  InterruptedRecording,
  RecordingSources,
  RecordingState,
  RecoveredRecording,
  RegionDrawing,
  SessionReference,
  StartRecordingRequest,
} from './recording';
import type { Result } from './result';
import type { RuntimeInfo } from './runtime-info';
import type { AppSettings, UpdateSettingsRequest } from './settings';
import type { PictureAnalysisDto, SavePictureChangesRequest } from './picture-changes';

/** The global name preload exposes the bridge under: `window.desktop`. */
export const DESKTOP_BRIDGE_KEY = 'desktop';

/**
 * The renderer's entire authority over the desktop. Each method maps to one
 * allow-listed channel in `desktopInvokeChannels` or `desktopEventChannels`;
 * there is deliberately no generic `invoke`, `send`, `readFile` or
 * `runCommand` (docs/ipc.md).
 */
export interface DesktopBridge {
  getRuntimeInfo(): Promise<Result<RuntimeInfo>>;

  listRecordingSources(): Promise<Result<RecordingSources>>;
  getRecordingState(): Promise<Result<RecordingState>>;
  startRecording(request: StartRecordingRequest): Promise<Result<RecordingState>>;
  stopRecording(): Promise<Result<RecordingState>>;
  /** Opens the area picker over a display and replies with the area drawn, or null (ADR-009). */
  chooseRecordingRegion(request: ChooseRegionRequest): Promise<Result<ChosenRegion>>;
  /** The area picker page's answer; nothing else calls it. */
  finishRegionChoice(request: RegionDrawing): Promise<Result<null>>;
  /** Returns a function that removes the listener. */
  onRecordingStateChanged(listener: (state: RecordingState) => void): () => void;

  listInterruptedRecordings(): Promise<Result<readonly InterruptedRecording[]>>;
  recoverRecording(request: SessionReference): Promise<Result<RecoveredRecording>>;
  discardRecording(request: SessionReference): Promise<Result<SessionReference>>;

  listProjects(): Promise<Result<readonly ProjectSummary[]>>;
  openProject(request: ProjectReference): Promise<Result<ProjectSnapshot>>;
  getProject(): Promise<Result<ProjectSnapshot | null>>;
  closeProject(): Promise<Result<null>>;
  editProject(request: EditProjectRequest): Promise<Result<ProjectSnapshot>>;
  undoProjectEdit(): Promise<Result<ProjectSnapshot>>;
  redoProjectEdit(): Promise<Result<ProjectSnapshot>>;
  saveProject(): Promise<Result<ProjectSnapshot>>;
  getWaveform(request: WaveformRequest): Promise<Result<Waveform | null>>;
  getPointerTrack(request: AssetReference): Promise<Result<PointerTrackDto | null>>;
  getExportQueue(): Promise<Result<ExportQueueViewDto>>;
  queueExport(request: QueueExportRequestDto): Promise<Result<ExportJobStatusDto | null>>;
  cancelExport(request: ExportRenderJobReferenceDto): Promise<Result<null>>;
  getExportFrameContext(request: ExportJobReferenceDto): Promise<Result<ExportFrameContextDto>>;
  submitExportFrame(request: SubmitExportFrameRequestDto): Promise<Result<null>>;
  onExportFrameRequested(listener: (request: ExportFrameRequestDto) => void): () => void;
  onExportQueueChanged(listener: (job: ExportJobStatusDto) => void): () => void;
  /** Returns a function that removes the listener. */
  onProjectChanged(listener: (project: ProjectSnapshot | null) => void): () => void;

  saveProjectThumbnail(request: SaveProjectThumbnailRequest): Promise<Result<null>>;
  getPictureChanges(request: AssetReference): Promise<Result<PictureAnalysisDto | null>>;
  savePictureChanges(request: SavePictureChangesRequest): Promise<Result<null>>;

  getSettings(): Promise<Result<AppSettings>>;
  updateSettings(request: UpdateSettingsRequest): Promise<Result<AppSettings>>;
  showProjectsFolder(): Promise<Result<null>>;
}
