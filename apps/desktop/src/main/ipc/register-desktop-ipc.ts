import type { RecordingService } from '@usee/application';
import {
  desktopInvokeChannels,
  ok,
  type ProjectSnapshot,
  type Result,
  type RuntimeInfo,
} from '@usee/contracts';

import type { Projects } from '../project-composition';
import type { Exports } from '../export-composition';
import type { RegionPicker } from '../region-picker';
import type { Settings } from '../settings';
import type { InvokeRouter } from './invoke-router';

export interface DesktopIpcDependencies {
  readonly readRuntimeInfo: () => RuntimeInfo;
  readonly recording: Pick<
    RecordingService,
    'state' | 'listSources' | 'start' | 'stop' | 'listInterrupted' | 'recover' | 'discard'
  >;
  readonly projects: Pick<
    Projects,
    | 'list'
    | 'open'
    | 'current'
    | 'close'
    | 'edit'
    | 'undo'
    | 'redo'
    | 'save'
    | 'waveform'
    | 'pointerTrack'
    | 'pictureChanges'
    | 'savePictureChanges'
    | 'saveThumbnail'
  >;
  readonly exports: Pick<
    Exports,
    'initialize' | 'getQueue' | 'queue' | 'cancel' | 'frameContext' | 'submitFrame'
  >;
  readonly settings: Settings;
  readonly regionPicker: RegionPicker;
  /** Opens the projects folder in the system file manager. */
  readonly showProjectsFolder: () => Promise<Result<null>>;
}

/** The complete set of renderer capabilities. Handlers stay short: validate, dispatch, return. */
export function registerDesktopIpc(
  router: InvokeRouter,
  dependencies: DesktopIpcDependencies,
): void {
  const { recording, projects, exports: exportService } = dependencies;
  const channels = desktopInvokeChannels;

  router.handle(channels.getRuntimeInfo, () => ok(dependencies.readRuntimeInfo()));
  router.handle(channels.listRecordingSources, () => recording.listSources());
  router.handle(channels.getRecordingState, () => ok(recording.state));
  router.handle(channels.startRecording, (request) => recording.start(request));
  router.handle(channels.stopRecording, () => recording.stop());
  router.handle(channels.chooseRecordingRegion, ({ displayId }, { correlationId }) =>
    dependencies.regionPicker.choose(displayId, correlationId),
  );
  router.handle(channels.finishRegionChoice, (drawing) => {
    dependencies.regionPicker.finish(drawing);
    return ok(null);
  });
  router.handle(channels.listInterruptedRecordings, () => recording.listInterrupted());
  router.handle(channels.recoverRecording, ({ sessionId }) => recording.recover(sessionId));
  router.handle(channels.discardRecording, async ({ sessionId }) => {
    const discarded = await recording.discard(sessionId);
    return discarded.ok ? ok({ sessionId }) : discarded;
  });

  router.handle(channels.listProjects, () => projects.list());
  router.handle(channels.openProject, ({ projectPath }) => projects.open(projectPath));
  // The explicit result type keeps TypeScript from expanding the snapshot schema too deeply.
  router.handle(channels.getProject, (): Result<ProjectSnapshot | null> => ok(projects.current()));
  router.handle(channels.closeProject, () => projects.close());
  router.handle(channels.editProject, ({ command }) => projects.edit(command));
  router.handle(channels.undoProjectEdit, () => projects.undo());
  router.handle(channels.redoProjectEdit, () => projects.redo());
  router.handle(channels.saveProject, () => projects.save());
  router.handle(channels.getWaveform, ({ assetId }) => projects.waveform(assetId));
  router.handle(channels.getPointerTrack, ({ assetId }) => projects.pointerTrack(assetId));
  router.handle(channels.getExportQueue, async () => {
    const initialized = await exportService.initialize();
    return initialized.ok ? ok(exportService.getQueue()) : initialized;
  });
  router.handle(channels.queueExport, (request) => exportService.queue(request));
  router.handle(channels.cancelExport, ({ renderJobId }) => exportService.cancel(renderJobId));
  router.handle(channels.getExportFrameContext, ({ exportJobId }) =>
    exportService.frameContext(exportJobId),
  );
  router.handle(channels.submitExportFrame, ({ exportJobId, requestId, frame }) =>
    exportService.submitFrame(exportJobId, requestId, frame),
  );
  router.handle(channels.saveProjectThumbnail, ({ jpeg }) => projects.saveThumbnail(jpeg));
  router.handle(channels.getPictureChanges, ({ assetId }) => projects.pictureChanges(assetId));
  router.handle(channels.savePictureChanges, ({ assetId, analysis }) =>
    projects.savePictureChanges(assetId, analysis),
  );
  router.handle(channels.getSettings, () => ok(dependencies.settings.current()));
  router.handle(channels.updateSettings, (request) => dependencies.settings.update(request));
  router.handle(channels.showProjectsFolder, () => dependencies.showProjectsFolder());
}
