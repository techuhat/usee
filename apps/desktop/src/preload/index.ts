import { contextBridge, ipcRenderer } from 'electron';

import { DESKTOP_BRIDGE_KEY, disableValidationCodeGeneration } from '@usee/contracts';

import { createDesktopBridge } from './desktop-bridge';

disableValidationCodeGeneration();

contextBridge.exposeInMainWorld(
  DESKTOP_BRIDGE_KEY,
  createDesktopBridge(ipcRenderer, () => crypto.randomUUID()),
);
