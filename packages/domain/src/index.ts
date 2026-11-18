/**
 * Pure, serializable product semantics. This package imports no React,
 * Electron, Node, filesystem, FFmpeg or Windows APIs; scripts/check-boundaries.mjs
 * enforces that.
 */

export const DOMAIN_MODEL_VERSION = 1 as const;

export type {
  AnalysisProvenance,
  AnalysisRun,
  AutoZoomSettings,
  CameraAnalysisRun,
} from './analysis';
export { DEFAULT_AUTO_ZOOM_SETTINGS, findGeneratedZoom, withAnalysisRun } from './analysis';
export type { AssetBase, AudioAsset, EventAsset, MediaAsset, VideoAsset } from './assets';
export type {
  AspectRatio,
  CanvasBackground,
  CanvasShadow,
  CanvasStyle,
  PictureLayout,
} from './canvas';
export { canvasStyleProblem, DEFAULT_CANVAS_STYLE, outputAspect, pictureLayout } from './canvas';
export type { CameraKeyframe, CameraPose, CameraRotation, ZoomKeyframe, ZoomPose } from './camera';
export type {
  AnnotationEffect,
  AnnotationShape,
  ArrowAnnotation,
  BlurEffect,
  BlurRegion,
  BoxAnnotation,
  ClickEffect,
  CursorSettings,
  CustomEffect,
  Effect,
  EffectBase,
  EllipseBlurRegion,
  PolygonBlurRegion,
  RectangleBlurRegion,
  TextAnnotation,
  ZoomEffect,
} from './effects';
export { CLICK_EFFECTS, DEFAULT_CURSOR_SETTINGS } from './effects';
export type { ExportJob, ExportJobState, ExportPreset, RenderJob } from './export';
export { exportDimensions, EXPORT_PRESETS } from './export';
export type { ExportPresetId, RenderAsset, RenderClip, RenderPlan, RenderTrack } from './export';
export type { CursorShape, PointerButton, PointerEvent, PointerStream } from './interaction';
export { CURSOR_SHAPES, POINTER_BUTTONS } from './interaction';
export type { Easing, Keyframe } from './keyframes';
export type { Project, ProjectSettings } from './project';
export type {
  DisplayRecordingSource,
  RecordingSession,
  RecordingSource,
  RegionRecordingSource,
  WebcamRecordingSource,
  WindowRecordingSource,
} from './recording';
export type {
  RecordingLifecycle,
  RecordingLifecycleEvent,
  RecordingPhase,
} from './recording-lifecycle';
export { IDLE_RECORDING, nextRecordingState } from './recording-lifecycle';
export type { ActiveAnnotation } from './annotations';
export { activeAnnotationsAt, ANNOTATION_FADE_US } from './annotations';
export type { ActiveBlur } from './blur-mask';
export { activeBlursAt, blurRegionsAt } from './blur-mask';
export { CAMERA_PRESETS, presetKeyframes, type CameraPreset } from './camera-presets';
export type { CardTransform, Homography } from './camera-transform';
export {
  applyHomography,
  cardTransform,
  DEFAULT_LENS_DEGREES,
  isCropView,
  isFlatView,
} from './camera-transform';
export type { CameraView } from './camera-view';
export {
  cameraViewAt,
  clampView,
  FULL_FRAME,
  projectPoint,
  viewPose,
  zoomProgress,
  zoomViewAt,
} from './camera-view';
export type {
  ActiveClick,
  CursorPath,
  CursorState,
  PointerClick,
  PointerTrack,
} from './cursor-path';
export {
  activeClicksAt,
  CLICK_EFFECT_US,
  CURSOR_PATH_RATE_HZ,
  cursorAt,
  deriveCursorPath,
  pointerTrackFromStream,
} from './cursor-path';
export { ease, lerp } from './easing';
export type {
  CameraPlanConstraints,
  FocusCandidate,
  GeneratedZoom,
  RestFocusOptions,
} from './focus';
export {
  clickFocusCandidates,
  DEFAULT_CAMERA_PLAN,
  DEFAULT_REST_FOCUS,
  generatedZoomEffects,
  planCameraTrack,
  restFocusCandidates,
} from './focus';
export type { PictureChange, PictureFocusOptions } from './picture-focus';
export { DEFAULT_PICTURE_FOCUS, pictureFocusCandidates } from './picture-focus';
export type { CursorSource, FrameComposition, FrameCursor } from './frame-composition';
export { composeFrame, CURSOR_BOX_PX, pointerTimeOrigin } from './frame-composition';
export { FOLLOW_KEEP, FOLLOW_SIGMA_US, followPointer } from './camera-follow';
export type { TimeRange } from './time-range';
export type { Clip, Timeline, TimelineTrack } from './timeline';
export {
  cursorSettingsProblem,
  effectProblem,
  MAX_ANNOTATION_LINE,
  MAX_ANNOTATION_TEXT,
  MAX_ANNOTATION_TEXT_SIZE,
  MAX_BLUR_INTENSITY,
  MAX_CAMERA_TURN_DEGREES,
  MAX_LENS_DEGREES,
  MAX_ZOOM_SCALE,
  MIN_ANNOTATION_LINE,
  MIN_ANNOTATION_TEXT_SIZE,
  MIN_LENS_DEGREES,
  MIN_ZOOM_SCALE,
} from './effect-rules';
export type { ProjectCommand, ProjectEditError } from './project-edit';
export { applyProjectCommand } from './project-edit';
export type { TimelineCommand, TimelineEditContext, TimelineEditError } from './timeline-edit';
export {
  applyTimelineCommand,
  clipEndUs,
  clipSpeed,
  clipTimelineDurationUs,
  MAX_CLIP_SPEED,
  MIN_CLIP_SPEED,
  minimumClipDurationUs,
  timelineDurationUs,
} from './timeline-edit';
