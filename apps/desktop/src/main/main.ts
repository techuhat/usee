import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';

import { pointerFocusStrategy, pointerPictureFocusStrategy } from '@usee/application';
import { asCorrelationId, createAppError, desktopEventChannels, err, ok } from '@usee/contracts';

import { resolveDesktopEnvironment } from './desktop-environment';
import { reportFatalError } from './fatal-error';
import { createInvokeRouter } from './ipc/invoke-router';
import { registerDesktopIpc } from './ipc/register-desktop-ipc';
import { sendEvent } from './ipc/send-event';
import { createFileLogger } from './logging/logger';
import { createMainWindow } from './main-window';
import { composeExports, type Exports } from './export-composition';
import { resolveExportRuntimeSource } from './export-runtime-source';
import type { ExportFrameRequestDto } from '@usee/contracts';
import { composeProjects, type Projects } from './project-composition';
import { composeRecording, type Recording } from './recording-composition';
import { createRegionPicker } from './region-picker';
import { resolveRecordingEnvironment } from './recording-environment';
import { registerRendererProtocol, registerRendererScheme } from './renderer-protocol';
import { createRecordingControls, type RecordingControls } from './recording-controls';
import { readRuntimeInfo } from './runtime-info';
import { loadSettings, projectLooksFrom } from './settings';
import { buildContentSecurityPolicy } from './security/content-security-policy';
import {
  applyDevelopmentContentSecurityPolicy,
  denyAllPermissions,
} from './security/session-policy';
import { isTrustedUrl } from './security/trusted-origin';
import { guardWebContents } from './security/web-contents-guard';

// Both must happen before `ready`: every renderer is sandboxed, and app:// is
// registered as a secure, standard scheme.
app.enableSandbox();
registerRendererScheme();

const environment = resolveDesktopEnvironment({
  isPackaged: app.isPackaged,
  appPath: app.getAppPath(),
  rendererUrlOverride: process.env['ELECTRON_RENDERER_URL'],
});
const isTrusted = (url: string) => isTrustedUrl(url, environment.trustedOrigins);

// Automated tests keep every byte of app data in their own directory.
const testDataDirectory = process.env['USEE_TEST_DATA_DIR'];
if (!app.isPackaged && testDataDirectory !== undefined && path.isAbsolute(testDataDirectory)) {
  app.setPath('userData', path.join(testDataDirectory, 'user-data'));
}

let mainWindow: BrowserWindow | undefined;
let recording: Recording | undefined;
let projects: Projects | undefined;
let exportService: Exports | undefined;
let recordingControls: RecordingControls | undefined;
let quitting = false;

function showMainWindow(): void {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
    return;
  }
  mainWindow = createMainWindow(environment, (cause) =>
    reportFatalError('desktop.window.load-failed', cause),
  );
}

async function start(): Promise<void> {
  await app.whenReady();

  denyAllPermissions(session.defaultSession);
  if (environment.devServerOrigin !== undefined) {
    applyDevelopmentContentSecurityPolicy(
      session.defaultSession,
      environment.devServerOrigin,
      buildContentSecurityPolicy({
        mode: 'development',
        devServerOrigin: environment.devServerOrigin,
      }),
    );
  }
  const recordingEnvironment = resolveRecordingEnvironment({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    localAppData: process.env['LOCALAPPDATA'],
    tempDirectory: app.getPath('temp'),
    videosDirectory: app.getPath('videos'),
    logsDirectory: app.getPath('logs'),
    testDataDirectory,
    syntheticSource: process.env['USEE_ENABLE_SYNTHETIC_SOURCE'],
  });
  const logger = createFileLogger({
    directory: recordingEnvironment.logsDirectory,
    appVersion: app.getVersion(),
  });
  logger.log('INFO', 'desktop.started', 'desktop.main', { mode: environment.mode });
  const settings = await loadSettings({
    directory: app.getPath('userData'),
    logger,
    createCorrelationId: () => asCorrelationId(randomUUID()),
  });

  projects = composeProjects(
    recordingEnvironment.projectsRoot,
    logger,
    `usee ${app.getVersion()}`,
    () =>
      settings.current().analysis?.pictureFocus === true
        ? pointerPictureFocusStrategy
        : pointerFocusStrategy,
  );
  // Turning picture focus on or off plans the open project's camera again.
  settings.subscribe(() => projects?.reanalyse());
  registerRendererProtocol(environment.rendererRoot, projects.media, environment.trustedOrigins);
  projects.subscribe((snapshot) => {
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
      sendEvent(mainWindow.webContents, desktopEventChannels.projectChanged, snapshot, isTrusted);
    }
  });

  recording = await composeRecording(recordingEnvironment, logger, () =>
    projectLooksFrom(settings.current()),
  );
  const service = recording.service;
  recordingControls = createRecordingControls({
    window: () => mainWindow,
    stop: () => void service.stop(),
    // Automated tests drive the window, which a minimized one does not let them.
    hideWhileRecording: () =>
      settings.current().recording.hideWhileRecording !== false &&
      !(app.isPackaged === false && process.env['USEE_KEEP_WINDOW_WHILE_RECORDING'] === '1'),
  });
  recording.service.subscribe((state) => {
    recordingControls?.update(state.phase);
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
      sendEvent(
        mainWindow.webContents,
        desktopEventChannels.recordingStateChanged,
        state,
        isTrusted,
      );
    }
  });

  const router = createInvokeRouter(ipcMain, {
    isTrustedSender: isTrusted,
    createCorrelationId: () => asCorrelationId(randomUUID()),
    onHandlerFailure: ({ channel, correlationId, cause }) =>
      logger.log('ERROR', 'desktop.ipc.handler-failed', 'desktop.main', {
        channel,
        correlationId,
        errorName: cause instanceof Error ? cause.name : typeof cause,
      }),
  });
  exportService = await composeExports({
    projects,
    runtimeSource: resolveExportRuntimeSource({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
    }),
    userDataDirectory: app.getPath('userData'),
    videosDirectory: app.getPath('videos'),
    createCorrelationId: () => asCorrelationId(randomUUID()),
    async chooseDestination(defaultPath) {
      if (mainWindow === undefined || mainWindow.isDestroyed()) {
        return undefined;
      }
      const selection = await dialog.showSaveDialog(mainWindow, {
        title: 'Export video',
        buttonLabel: 'Export',
        defaultPath,
        filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
      });
      return selection.canceled ? undefined : selection.filePath;
    },
    async reportDestinationExists() {
      if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
        await dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'File already exists',
          message: 'usee does not replace an existing export.',
          detail: 'Choose a different name to continue.',
          buttons: ['Choose another name'],
        });
      }
    },
    sendFrameRequest(request: ExportFrameRequestDto) {
      if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
        sendEvent(
          mainWindow.webContents,
          desktopEventChannels.exportFrameRequested,
          request,
          isTrusted,
        );
      }
    },
    publishStatus(status) {
      if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
        sendEvent(
          mainWindow.webContents,
          desktopEventChannels.exportQueueChanged,
          status,
          isTrusted,
        );
      }
    },
  });

  registerDesktopIpc(router, {
    readRuntimeInfo,
    recording: recording.service,
    projects,
    exports: exportService,
    settings,
    regionPicker: createRegionPicker({
      environment,
      owner: () => mainWindow,
      listDisplays: () => service.listDisplays(),
    }),
    async showProjectsFolder() {
      const folder = recordingEnvironment.projectsRoot;
      await mkdir(folder, { recursive: true });
      if ((await shell.openPath(folder)) === '') {
        return ok(null);
      }
      logger.log('WARN', 'desktop.projects-folder.open-failed', 'desktop.main');
      return err(
        createAppError({
          category: 'storage',
          code: 'storage.folder-open-failed',
          retryable: true,
          userMessageKey: 'errors.storage.folder-open-failed',
          correlationId: asCorrelationId(randomUUID()),
        }),
      );
    },
  });

  showMainWindow();
}

/** Finalizes an active recording, saves the open project and stops the host before exit. */
async function shutDown(): Promise<void> {
  recordingControls?.dispose();
  await exportService?.shutdown();
  if (recording !== undefined) {
    // Stopping while finalizing joins the import already in progress.
    const { phase } = recording.service.state;
    if (phase === 'recording' || phase === 'finalizing') {
      await recording.service.stop();
    }
  }
  await projects?.close();
  await recording?.dispose();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);
  app.on('web-contents-created', (_event, contents) => guardWebContents(contents, isTrusted));
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      showMainWindow();
    }
  });
  app.on('before-quit', (event) => {
    if (quitting) {
      return;
    }
    event.preventDefault();
    quitting = true;
    shutDown()
      .catch((cause: unknown) => reportFatalError('desktop.shutdown.failed', cause))
      .finally(() => app.quit());
  });

  start().catch((cause: unknown) => {
    reportFatalError('desktop.startup.failed', cause);
    app.exit(1);
  });
}
