import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { _electron as electron, type ElectronApplication } from '@playwright/test';

// Playwright loads these specs as CommonJS (the root package has no "type": "module").
const desktopDirectory = path.resolve(__dirname, '..', '..', 'apps', 'desktop');

export const hostExecutable = path.resolve(
  __dirname,
  '..',
  '..',
  'native',
  'recorder-host',
  'build',
  'release',
  'recorder-host.exe',
);

// ELECTRON_RUN_AS_NODE leaks in from VS Code and would start electron.exe as plain Node.
const DROPPED_VARIABLES = new Set(['ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE']);

export interface LaunchedApp {
  readonly app: ElectronApplication;
  /** Holds staging, projects, logs and user data for this run only. */
  readonly dataDirectory: string;
  close(): Promise<void>;
}

/**
 * Launches the built desktop app as `npm start` would, with all of its data
 * redirected to a fresh temporary directory so tests never touch the real
 * profile, and with the synthetic source instead of the real screen. A test
 * that starts the app again on the same data passes `dataDirectory`, and
 * removes it itself.
 */
export async function launchDesktopApp(
  options: {
    readonly dataDirectory?: string;
    readonly hideWhileRecording?: boolean;
    /** Lets a first start open with the welcome tour, as it does outside tests. */
    readonly welcome?: boolean;
  } = {},
): Promise<LaunchedApp> {
  const dataDirectory = options.dataDirectory ?? (await mkdtemp(path.join(tmpdir(), 'usee-e2e-')));
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !DROPPED_VARIABLES.has(entry[0]),
    ),
  );
  environment['USEE_TEST_DATA_DIR'] = dataDirectory;
  environment['USEE_ENABLE_SYNTHETIC_SOURCE'] = '1';
  // A minimized window cannot be clicked; the recording-controls test opts back in.
  if (options.hideWhileRecording !== true) {
    environment['USEE_KEEP_WINDOW_WHILE_RECORDING'] = '1';
  }
  if (options.welcome !== true) {
    environment['USEE_SKIP_WELCOME'] = '1';
  }

  // One device pixel per CSS pixel, so screenshots are the same size on any display scale.
  const app = await electron.launch({
    args: ['--force-device-scale-factor=1', desktopDirectory],
    env: environment,
  });
  // The page the preview goldens were made at, on every machine: the window's frame, drawn
  // at the display's own scaling, would otherwise leave more or less of 1360 x 900 to it.
  await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1328, 786);
  });
  // An app that dies mid-test says why: its exit and the end of its stderr go to the test output.
  const child = app.process();
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4_000);
  });
  child.on('exit', (code, signal) => {
    if ((code !== 0 && code !== null) || signal !== null) {
      console.log(`The app exited (code ${String(code)}, signal ${String(signal)}):
${stderr}`);
    }
  });
  return {
    app,
    dataDirectory,
    async close() {
      await app.close();
      if (options.dataDirectory === undefined) {
        await rm(dataDirectory, { recursive: true, force: true });
      }
    },
  };
}
