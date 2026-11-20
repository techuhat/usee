import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { launchDesktopApp, type LaunchedApp } from './launch-app';

// The version each release sets, so the check needs no edit per release.
const { version } = JSON.parse(
  readFileSync(path.resolve(__dirname, '..', '..', 'apps', 'desktop', 'package.json'), 'utf8'),
) as { version: string };

let launched: LaunchedApp;
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  launched = await launchDesktopApp();
  app = launched.app;
  page = await app.firstWindow();
});

test.afterAll(async () => {
  await launched.close();
});

test('boots the bundled renderer from app:// and shows runtime info', async () => {
  await expect(page).toHaveTitle('usee');
  expect(page.url()).toBe('app://renderer/index.html');
  await expect(page.getByRole('heading', { level: 1, name: 'usee' })).toBeVisible();
  await expect(page.getByTestId('runtime-summary')).toContainText(`Version ${version}`);
});

test('exposes only the typed desktop bridge to the page', async () => {
  const exposure = await page.evaluate(() => ({
    bridgeKeys: Object.keys(window.desktop).sort(),
    hasRequire: 'require' in globalThis,
    hasProcess: 'process' in globalThis,
    hasIpcRenderer: 'ipcRenderer' in globalThis,
  }));
  expect(exposure).toEqual({
    bridgeKeys: [
      'cancelExport',
      'chooseRecordingRegion',
      'closeProject',
      'discardRecording',
      'editProject',
      'finishRegionChoice',
      'getExportFrameContext',
      'getExportQueue',
      'getPictureChanges',
      'getPointerTrack',
      'getProject',
      'getRecordingState',
      'getRuntimeInfo',
      'getSettings',
      'getWaveform',
      'listInterruptedRecordings',
      'listProjects',
      'listRecordingSources',
      'onExportFrameRequested',
      'onExportQueueChanged',
      'onProjectChanged',
      'onRecordingStateChanged',
      'openProject',
      'queueExport',
      'recoverRecording',
      'redoProjectEdit',
      'savePictureChanges',
      'saveProject',
      'saveProjectThumbnail',
      'showProjectsFolder',
      'startRecording',
      'stopRecording',
      'submitExportFrame',
      'undoProjectEdit',
      'updateSettings',
    ],
    hasRequire: false,
    hasProcess: false,
    hasIpcRenderer: false,
  });

  const reply = await page.evaluate(() => window.desktop.getRuntimeInfo());
  expect(reply).toMatchObject({ ok: true, value: { applicationName: 'usee' } });
});

test('enforces the content security policy', async () => {
  // DevTools-protocol evaluation exempts its own synchronous frame from CSP's eval
  // check (allowUnsafeEvalBlockedByCSP), so each probe first yields to a timer and
  // then runs as ordinary page code.
  const probes = await page.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));

    const inline = document.createElement('script');
    inline.textContent = 'document.documentElement.dataset.inlineScriptRan = "yes";';
    document.head.append(inline);

    let evalBlocked = false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call -- proving eval is blocked
      new Function('return 1')();
    } catch {
      evalBlocked = true;
    }

    return {
      inlineScriptRan: document.documentElement.dataset['inlineScriptRan'] === 'yes',
      evalBlocked,
    };
  });
  expect(probes).toEqual({ inlineScriptRan: false, evalBlocked: true });

  const remoteFetch = await page.evaluate(async () => {
    try {
      await fetch('https://example.com/');
      return 'reached';
    } catch {
      return 'blocked';
    }
  });
  expect(remoteFetch).toBe('blocked');
});

test('refuses to navigate the window to remote content', async () => {
  await page.evaluate(() => {
    window.location.href = 'https://example.com/';
  });
  await page.waitForTimeout(500);
  expect(page.url()).toBe('app://renderer/index.html');
});

test('denies new windows', async () => {
  const opened = await page.evaluate(() => window.open('https://example.com/') !== null);
  expect(opened).toBe(false);
  expect(app.windows()).toHaveLength(1);
});
