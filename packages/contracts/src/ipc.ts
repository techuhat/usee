import { z } from 'zod';

import { pointerTrackSchema } from './pointer';
import {
  assetReferenceSchema,
  editProjectRequestSchema,
  projectReferenceSchema,
  projectSnapshotSchema,
  projectSummarySchema,
  saveProjectThumbnailRequestSchema,
  waveformRequestSchema,
  waveformSchema,
} from './project';
import {
  chooseRegionRequestSchema,
  chosenRegionSchema,
  interruptedRecordingSchema,
  recordingSourcesSchema,
  recordingStateSchema,
  recoveredRecordingSchema,
  regionDrawingSchema,
  sessionReferenceSchema,
  startRecordingRequestSchema,
} from './recording';
import { resultSchema, type Result } from './result';
import { runtimeInfoSchema } from './runtime-info';
import { appSettingsSchema, updateSettingsRequestSchema } from './settings';
import { pictureAnalysisSchema, savePictureChangesRequestSchema } from './picture-changes';
import {
  exportFrameContextSchema,
  exportFrameRequestSchema,
  exportJobReferenceSchema,
  exportJobStatusSchema,
  exportQueueViewSchema,
  exportRenderJobReferenceSchema,
  queueExportRequestSchema,
  submitExportFrameRequestSchema,
} from './desktop-export';

/** Bumped on any incompatible change to a channel's name or schemas. */
export const IPC_PROTOCOL_VERSION = 1 as const;

/** `desktop.<area>.<verb-phrase>`, for example `desktop.app.get-runtime-info`. */
const CHANNEL_PATTERN = /^desktop(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*){2,}$/;

/** A renderer → main request answered with a `Result` (`ipcRenderer.invoke`). */
export interface InvokeChannel<
  Request extends z.ZodType = z.ZodType,
  Response extends z.ZodType = z.ZodType,
> {
  readonly kind: 'invoke';
  readonly channel: string;
  readonly request: Request;
  readonly response: Response;
}

/** A main → renderer notification (`webContents.send`). */
export interface EventChannel<Payload extends z.ZodType = z.ZodType> {
  readonly kind: 'event';
  readonly channel: string;
  readonly payload: Payload;
}

export type InvokeRequest<Channel extends InvokeChannel> = z.output<Channel['request']>;
export type InvokeResponse<Channel extends InvokeChannel> = z.output<Channel['response']>;
export type EventPayload<Channel extends EventChannel> = z.output<Channel['payload']>;

export type SchemaParseResult<Value> =
  | { readonly success: true; readonly data: Value }
  | { readonly success: false; readonly error: z.ZodError };

// On a generic channel, `schema.safeParse` resolves to the constraint's output
// type (`unknown`). These helpers restore the channel's precise types; the
// runtime guarantee is zod's own parse.

export function parseInvokeRequest<Channel extends InvokeChannel>(
  definition: Channel,
  value: unknown,
): SchemaParseResult<InvokeRequest<Channel>> {
  return definition.request.safeParse(value) as SchemaParseResult<InvokeRequest<Channel>>;
}

export function parseInvokeResponse<Channel extends InvokeChannel>(
  definition: Channel,
  value: unknown,
): SchemaParseResult<InvokeResponse<Channel>> {
  return definition.response.safeParse(value) as SchemaParseResult<InvokeResponse<Channel>>;
}

/** Validates a whole `Result` reply, as received by the preload bridge. */
export function parseInvokeResult<Channel extends InvokeChannel>(
  definition: Channel,
  value: unknown,
): SchemaParseResult<Result<InvokeResponse<Channel>>> {
  return resultSchema(definition.response).safeParse(value) as SchemaParseResult<
    Result<InvokeResponse<Channel>>
  >;
}

export function parseEventPayload<Channel extends EventChannel>(
  definition: Channel,
  value: unknown,
): SchemaParseResult<EventPayload<Channel>> {
  return definition.payload.safeParse(value) as SchemaParseResult<EventPayload<Channel>>;
}

function assertChannelName(channel: string): void {
  if (!CHANNEL_PATTERN.test(channel)) {
    throw new TypeError(`Invalid IPC channel name "${channel}".`);
  }
}

export function defineInvokeChannel<Request extends z.ZodType, Response extends z.ZodType>(
  definition: Readonly<{ channel: string; request: Request; response: Response }>,
): InvokeChannel<Request, Response> {
  assertChannelName(definition.channel);
  return Object.freeze({ kind: 'invoke', ...definition });
}

export function defineEventChannel<Payload extends z.ZodType>(
  definition: Readonly<{ channel: string; payload: Payload }>,
): EventChannel<Payload> {
  assertChannelName(definition.channel);
  return Object.freeze({ kind: 'event', ...definition });
}

/**
 * Every renderer → main capability. Adding an entry is an architecture change:
 * it needs an application port, schemas, an error model and tests
 * (docs/ipc.md, ADR-007).
 */
export const desktopInvokeChannels = Object.freeze({
  getRuntimeInfo: defineInvokeChannel({
    channel: 'desktop.app.get-runtime-info',
    request: z.undefined(),
    response: runtimeInfoSchema,
  }),
  listRecordingSources: defineInvokeChannel({
    channel: 'desktop.recording.list-sources',
    request: z.undefined(),
    response: recordingSourcesSchema,
  }),
  getRecordingState: defineInvokeChannel({
    channel: 'desktop.recording.get-state',
    request: z.undefined(),
    response: recordingStateSchema,
  }),
  startRecording: defineInvokeChannel({
    channel: 'desktop.recording.start',
    request: startRecordingRequestSchema,
    response: recordingStateSchema,
  }),
  stopRecording: defineInvokeChannel({
    channel: 'desktop.recording.stop',
    request: z.undefined(),
    response: recordingStateSchema,
  }),
  /** Opens the area picker over a display; replies once an area is chosen or it is cancelled. */
  chooseRecordingRegion: defineInvokeChannel({
    channel: 'desktop.recording.choose-region',
    request: chooseRegionRequestSchema,
    response: chosenRegionSchema,
  }),
  /** The area picker page's answer. */
  finishRegionChoice: defineInvokeChannel({
    channel: 'desktop.recording.finish-region',
    request: regionDrawingSchema,
    response: z.null(),
  }),
  listInterruptedRecordings: defineInvokeChannel({
    channel: 'desktop.recovery.list',
    request: z.undefined(),
    response: z.array(interruptedRecordingSchema).readonly(),
  }),
  recoverRecording: defineInvokeChannel({
    channel: 'desktop.recovery.recover',
    request: sessionReferenceSchema,
    response: recoveredRecordingSchema,
  }),
  discardRecording: defineInvokeChannel({
    channel: 'desktop.recovery.discard',
    request: sessionReferenceSchema,
    response: sessionReferenceSchema,
  }),
  listProjects: defineInvokeChannel({
    channel: 'desktop.project.list',
    request: z.undefined(),
    response: z.array(projectSummarySchema).max(1_000).readonly(),
  }),
  /** Only bundles directly inside the projects folder can be opened. */
  openProject: defineInvokeChannel({
    channel: 'desktop.project.open',
    request: projectReferenceSchema,
    response: projectSnapshotSchema,
  }),
  getProject: defineInvokeChannel({
    channel: 'desktop.project.get',
    request: z.undefined(),
    response: projectSnapshotSchema.nullable(),
  }),
  closeProject: defineInvokeChannel({
    channel: 'desktop.project.close',
    request: z.undefined(),
    response: z.null(),
  }),
  editProject: defineInvokeChannel({
    channel: 'desktop.project.edit',
    request: editProjectRequestSchema,
    response: projectSnapshotSchema,
  }),
  undoProjectEdit: defineInvokeChannel({
    channel: 'desktop.project.undo',
    request: z.undefined(),
    response: projectSnapshotSchema,
  }),
  redoProjectEdit: defineInvokeChannel({
    channel: 'desktop.project.redo',
    request: z.undefined(),
    response: projectSnapshotSchema,
  }),
  /** Retries after a failed background save. */
  saveProject: defineInvokeChannel({
    channel: 'desktop.project.save',
    request: z.undefined(),
    response: projectSnapshotSchema,
  }),
  getWaveform: defineInvokeChannel({
    channel: 'desktop.project.get-waveform',
    request: waveformRequestSchema,
    response: waveformSchema.nullable(),
  }),
  /** A pointer stream asset of the open project, by the ID its media names. */
  getPointerTrack: defineInvokeChannel({
    channel: 'desktop.project.get-pointer-track',
    request: assetReferenceSchema,
    response: pointerTrackSchema.nullable(),
  }),
  getExportQueue: defineInvokeChannel({
    channel: 'desktop.export.get-queue',
    request: z.undefined(),
    response: exportQueueViewSchema,
  }),
  queueExport: defineInvokeChannel({
    channel: 'desktop.export.queue',
    request: queueExportRequestSchema,
    response: exportJobStatusSchema.nullable(),
  }),
  cancelExport: defineInvokeChannel({
    channel: 'desktop.export.cancel',
    request: exportRenderJobReferenceSchema,
    response: z.null(),
  }),
  getExportFrameContext: defineInvokeChannel({
    channel: 'desktop.export.get-frame-context',
    request: exportJobReferenceSchema,
    response: exportFrameContextSchema,
  }),
  submitExportFrame: defineInvokeChannel({
    channel: 'desktop.export.submit-frame',
    request: submitExportFrameRequestSchema,
    response: z.null(),
  }),
  /** Keeps a small picture of the open project for the project list. */
  saveProjectThumbnail: defineInvokeChannel({
    channel: 'desktop.project.save-thumbnail',
    request: saveProjectThumbnailRequestSchema,
    response: z.null(),
  }),
  /** Where a recording of the open project changed, if the editor has read its picture. */
  getPictureChanges: defineInvokeChannel({
    channel: 'desktop.project.get-picture-changes',
    request: assetReferenceSchema,
    response: pictureAnalysisSchema.nullable(),
  }),
  /** Keeps what the editor found in a recording's picture; main then plans the camera again. */
  savePictureChanges: defineInvokeChannel({
    channel: 'desktop.project.save-picture-changes',
    request: savePictureChangesRequestSchema,
    response: z.null(),
  }),
  getSettings: defineInvokeChannel({
    channel: 'desktop.settings.get',
    request: z.undefined(),
    response: appSettingsSchema,
  }),
  /** Replaces the sections it names; main validates the whole result before saving it. */
  updateSettings: defineInvokeChannel({
    channel: 'desktop.settings.update',
    request: updateSettingsRequestSchema,
    response: appSettingsSchema,
  }),
  /** Opens the projects folder, which main alone knows, in the system file manager. */
  showProjectsFolder: defineInvokeChannel({
    channel: 'desktop.app.show-projects-folder',
    request: z.undefined(),
    response: z.null(),
  }),
});

/** Every main → renderer notification. */
export const desktopEventChannels = Object.freeze({
  recordingStateChanged: defineEventChannel({
    channel: 'desktop.recording.state-changed',
    payload: recordingStateSchema,
  }),
  /** The open project after any change, or null once it closes. */
  projectChanged: defineEventChannel({
    channel: 'desktop.project.changed',
    payload: projectSnapshotSchema.nullable(),
  }),
  exportFrameRequested: defineEventChannel({
    channel: 'desktop.export.frame-requested',
    payload: exportFrameRequestSchema,
  }),
  exportQueueChanged: defineEventChannel({
    channel: 'desktop.export.queue-changed',
    payload: exportJobStatusSchema,
  }),
});
