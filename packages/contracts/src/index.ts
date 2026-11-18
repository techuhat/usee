/**
 * Stable values shared across process and package boundaries: branded IDs,
 * time units, geometry, the `Result`/`AppError` model and the IPC registry.
 * Schemas validate untrusted input at adapter boundaries; the inferred types
 * describe values that have already crossed one successfully.
 */

export const CONTRACTS_API_VERSION = 1 as const;

export type { Brand } from './brand';
export type { CancellationToken } from './cancellation';
export type { DesktopBridge } from './desktop-bridge';
export { DESKTOP_BRIDGE_KEY } from './desktop-bridge';
export type { AnnotationShapeDto, CursorSettingsDto, EffectDto } from './effects';
export {
  exportFrameContextSchema,
  exportFrameRequestSchema,
  exportJobReferenceSchema,
  exportPresetIdSchema,
  exportQueueViewSchema,
  exportRenderJobReferenceSchema,
  exportRuntimeStatusSchema,
  queueExportRequestSchema,
  submitExportFrameRequestSchema,
} from './desktop-export';
export type {
  ExportFrameContextDto,
  ExportFrameRequestDto,
  ExportJobReferenceDto,
  ExportJobStatusDto,
  ExportQueueViewDto,
  ExportRenderJobReferenceDto,
  ExportRuntimeStatusDto,
  QueueExportRequestDto,
  SubmitExportFrameRequestDto,
} from './desktop-export';
export type { AnalysisRunDto, AutoZoomSettingsDto, GeneratedZoomDto } from './analysis';
export { analysisRunSchema, autoZoomSettingsSchema, generatedZoomSchema } from './analysis';
export {
  annotationShapeSchema,
  blurRegionSchema,
  cursorSettingsSchema,
  effectSchema,
} from './effects';
export type { CanvasStyleDto } from './canvas';
export { aspectRatioSchema, canvasBackgroundSchema, canvasStyleSchema } from './canvas';
export type { AppError, AppErrorFields, DiagnosticValue, ErrorCategory } from './errors';
export { appErrorSchema, createAppError, ERROR_CATEGORIES } from './errors';
export {
  exportQueueEntrySchema,
  exportQueueSnapshotSchema,
  renderAssetSchema,
  renderClipSchema,
  renderJobSchema,
  renderPlanSchema,
} from './export-queue';
export type {
  ExportQueueEntryDto,
  ExportQueueSnapshotDto,
  RenderAssetDto,
  RenderClipDto,
  RenderJobDto,
  RenderPlanDto,
} from './export-queue';
export type { CoordinateSpace, FrameRate, PixelSize, Point, Rectangle } from './geometry';
export {
  COORDINATE_SPACES,
  coordinateSpaceSchema,
  frameRateSchema,
  pixelSizeSchema,
  pointSchema,
  rectangleSchema,
} from './geometry';
export type {
  AssetId,
  ClipId,
  CorrelationId,
  EffectId,
  JobId,
  ProjectId,
  RecordingSessionId,
  TimelineId,
  TrackId,
} from './ids';
export {
  asAssetId,
  asClipId,
  asCorrelationId,
  asEffectId,
  asJobId,
  asProjectId,
  asRecordingSessionId,
  assetIdSchema,
  asTimelineId,
  asTrackId,
  clipIdSchema,
  correlationIdSchema,
  effectIdSchema,
  isOpaqueId,
  jobIdSchema,
  projectIdSchema,
  recordingSessionIdSchema,
  timelineIdSchema,
  trackIdSchema,
} from './ids';
export type {
  EventChannel,
  EventPayload,
  InvokeChannel,
  InvokeRequest,
  InvokeResponse,
  SchemaParseResult,
} from './ipc';
export {
  defineEventChannel,
  defineInvokeChannel,
  desktopEventChannels,
  desktopInvokeChannels,
  IPC_PROTOCOL_VERSION,
  parseEventPayload,
  parseInvokeRequest,
  parseInvokeResponse,
  parseInvokeResult,
} from './ipc';
export type {
  PictureAnalysisDto,
  PictureChangeDto,
  SavePictureChangesRequest,
} from './picture-changes';
export {
  pictureAnalysisSchema,
  pictureChangeSchema,
  savePictureChangesRequestSchema,
} from './picture-changes';
export type {
  AnalysisSettings,
  AppSettings,
  ExportDefaults,
  NewProjectDefaults,
  RecordingDefaults,
  UpdateSettingsRequest,
  WelcomeSettings,
} from './settings';
export {
  analysisSettingsSchema,
  appSettingsSchema,
  exportDefaultsSchema,
  newProjectDefaultsSchema,
  recordingDefaultsSchema,
  SETTINGS_VERSION,
  updateSettingsRequestSchema,
  welcomeSettingsSchema,
} from './settings';
export type {
  AssetReference,
  EditProjectRequest,
  ProjectCommandRequest,
  ProjectReference,
  ProjectSnapshot,
  ProjectSummary,
  SaveProjectThumbnailRequest,
  Waveform,
  WaveformRequest,
} from './project';
export {
  assetReferenceSchema,
  editProjectRequestSchema,
  MEDIA_URL_PATTERN,
  projectCommandSchema,
  projectReferenceSchema,
  projectSnapshotSchema,
  projectSummarySchema,
  MAX_THUMBNAIL_BYTES,
  saveProjectThumbnailRequestSchema,
  waveformRequestSchema,
  waveformSchema,
} from './project';
export type {
  CaptureSource,
  ChooseRegionRequest,
  ChosenRegion,
  InterruptedRecording,
  RecordingMetrics,
  RecordingSources,
  RecordingState,
  RecoveredRecording,
  RegionDrawing,
  SessionReference,
  StartRecordingRequest,
} from './recording';
export {
  captureSourceSchema,
  chooseRegionRequestSchema,
  chosenRegionSchema,
  interruptedRecordingSchema,
  recordingMetricsSchema,
  recordingSourcesSchema,
  recordingStateSchema,
  recoveredRecordingSchema,
  REGION_PICKER_HASH,
  regionDrawingSchema,
  sessionReferenceSchema,
  startRecordingRequestSchema,
} from './recording';
export type {
  HostAudioInput,
  HostDisplay,
  HostError,
  HostMergedRecording,
  HostMessage,
  HostRegion,
  HostSegment,
  HostSessionState,
  HostSessionSummary,
  HostWindow,
  JournalRecord,
  RecorderEventData,
  RecorderEventName,
  RecorderMethod,
  RecorderParams,
  RecorderResult,
} from './recorder-protocol';
export {
  HOST_SESSION_STATES,
  hostAudioInputSchema,
  hostDisplaySchema,
  hostErrorToAppError,
  hostErrorSchema,
  hostMergedRecordingSchema,
  hostMessageSchema,
  hostRegionSchema,
  hostSegmentSchema,
  hostSessionSummarySchema,
  hostWindowSchema,
  journalRecordSchema,
  MERGE_OUTPUT_FILE_NAMES,
  MERGED_RECORDING_FILE_NAME,
  POINTER_FILE_NAME,
  RECORDER_MAX_FRAME_BYTES,
  RECORDER_PROTOCOL_VERSION,
  recorderEvents,
  recorderMethods,
  SEGMENT_FILE_NAME_PATTERN,
  WAVEFORM_FILE_NAME,
} from './recorder-protocol';
export type { CursorShape, PointerButton, PointerTrackDto } from './pointer';
export { CURSOR_SHAPES, POINTER_BUTTONS, pointerTrackSchema } from './pointer';
export type { JsonPrimitive, JsonValue } from './json';
export { jsonValueSchema } from './json';
export type { Err, Ok, Result } from './result';
export { err, ok, resultSchema } from './result';
export type { RuntimeInfo } from './runtime-info';
export { runtimeInfoSchema } from './runtime-info';
export type { DurationUs, SchemaVersion, TimestampUs } from './time';
export {
  asDurationUs,
  asSchemaVersion,
  asTimestampUs,
  durationUsSchema,
  schemaVersionSchema,
  timestampUsSchema,
} from './time';
export { disableValidationCodeGeneration } from './validation';
export type { FfmpegRuntimeManifest } from './ffmpeg-runtime';
export { ffmpegRuntimeManifestSchema } from './ffmpeg-runtime';
