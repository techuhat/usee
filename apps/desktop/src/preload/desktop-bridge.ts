import type { IpcRenderer, IpcRendererEvent } from 'electron';

import {
  asCorrelationId,
  createAppError,
  desktopEventChannels,
  desktopInvokeChannels,
  err,
  parseEventPayload,
  parseInvokeResult,
  type AppError,
  type DesktopBridge,
  type Err,
  type EventChannel,
  type EventPayload,
  type InvokeChannel,
  type InvokeRequest,
  type InvokeResponse,
  type Result,
} from '@usee/contracts';

type LocalFailureCode = 'ipc.unavailable' | 'ipc.invalid-response';

/**
 * Builds the frozen object exposed as `window.desktop`. Each method invokes
 * one allow-listed channel and validates the reply before the page sees it;
 * the returned promises never reject. Event payloads are validated too.
 */
export function createDesktopBridge(
  ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>,
  createCorrelationId: () => string,
): DesktopBridge {
  const localFailure = (code: LocalFailureCode): Err<AppError> =>
    err(
      createAppError({
        category: 'ipc',
        code,
        retryable: code === 'ipc.unavailable',
        userMessageKey: `errors.${code}`,
        correlationId: asCorrelationId(createCorrelationId()),
      }),
    );

  async function invoke<Channel extends InvokeChannel>(
    definition: Channel,
    request: InvokeRequest<Channel>,
  ): Promise<Result<InvokeResponse<Channel>>> {
    let reply: unknown;
    try {
      reply = await ipc.invoke(definition.channel, request);
    } catch {
      return localFailure('ipc.unavailable');
    }

    const parsed = parseInvokeResult(definition, reply);
    return parsed.success ? parsed.data : localFailure('ipc.invalid-response');
  }

  function subscribe<Channel extends EventChannel>(
    definition: Channel,
    listener: (payload: EventPayload<Channel>) => void,
  ): () => void {
    const handler = (_event: IpcRendererEvent, payload: unknown) => {
      const parsed = parseEventPayload(definition, payload);
      if (parsed.success) {
        listener(parsed.data);
      }
    };
    ipc.on(definition.channel, handler);
    return () => {
      ipc.removeListener(definition.channel, handler);
    };
  }

  const channels = desktopInvokeChannels;
  return Object.freeze({
    getRuntimeInfo: () => invoke(channels.getRuntimeInfo, undefined),
    listRecordingSources: () => invoke(channels.listRecordingSources, undefined),
    getRecordingState: () => invoke(channels.getRecordingState, undefined),
    startRecording: (request) => invoke(channels.startRecording, request),
    stopRecording: () => invoke(channels.stopRecording, undefined),
    chooseRecordingRegion: (request) => invoke(channels.chooseRecordingRegion, request),
    finishRegionChoice: (request) => invoke(channels.finishRegionChoice, request),
    onRecordingStateChanged: (listener) =>
      subscribe(desktopEventChannels.recordingStateChanged, listener),
    listInterruptedRecordings: () => invoke(channels.listInterruptedRecordings, undefined),
    recoverRecording: (request) => invoke(channels.recoverRecording, request),
    discardRecording: (request) => invoke(channels.discardRecording, request),
    listProjects: () => invoke(channels.listProjects, undefined),
    openProject: (request) => invoke(channels.openProject, request),
    getProject: () => invoke(channels.getProject, undefined),
    closeProject: () => invoke(channels.closeProject, undefined),
    editProject: (request) => invoke(channels.editProject, request),
    undoProjectEdit: () => invoke(channels.undoProjectEdit, undefined),
    redoProjectEdit: () => invoke(channels.redoProjectEdit, undefined),
    saveProject: () => invoke(channels.saveProject, undefined),
    getWaveform: (request) => invoke(channels.getWaveform, request),
    getPointerTrack: (request) => invoke(channels.getPointerTrack, request),
    getExportQueue: () => invoke(channels.getExportQueue, undefined),
    queueExport: (request) => invoke(channels.queueExport, request),
    cancelExport: (request) => invoke(channels.cancelExport, request),
    getExportFrameContext: (request) => invoke(channels.getExportFrameContext, request),
    submitExportFrame: (request) => invoke(channels.submitExportFrame, request),
    onProjectChanged: (listener) => subscribe(desktopEventChannels.projectChanged, listener),
    onExportFrameRequested: (listener) =>
      subscribe(desktopEventChannels.exportFrameRequested, listener),
    onExportQueueChanged: (listener) =>
      subscribe(desktopEventChannels.exportQueueChanged, listener),
    saveProjectThumbnail: (request) => invoke(channels.saveProjectThumbnail, request),
    getPictureChanges: (request) => invoke(channels.getPictureChanges, request),
    savePictureChanges: (request) => invoke(channels.savePictureChanges, request),
    getSettings: () => invoke(channels.getSettings, undefined),
    updateSettings: (request) => invoke(channels.updateSettings, request),
    showProjectsFolder: () => invoke(channels.showProjectsFolder, undefined),
  } satisfies DesktopBridge);
}
