import { BrowserWindow, type WebPreferences } from 'electron';

import type { DesktopEnvironment } from './desktop-environment';

/** Every app window's renderer: sandboxed and isolated, with only the preload's bridge. */
export function rendererWebPreferences(environment: DesktopEnvironment): WebPreferences {
  return {
    preload: environment.preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    spellcheck: false,
  };
}

export function createMainWindow(
  environment: DesktopEnvironment,
  onLoadFailure: (cause: unknown) => void,
): BrowserWindow {
  const window = new BrowserWindow({
    // Room for the editor's picture beside its timeline; Windows shrinks it to fit smaller screens.
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'usee',
    backgroundColor: '#10131a',
    webPreferences: rendererWebPreferences(environment),
  });

  window.once('ready-to-show', () => window.show());
  window.loadURL(environment.rendererEntryUrl).catch(onLoadFailure);

  return window;
}
