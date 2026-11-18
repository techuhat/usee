import { app } from 'electron';

import type { RuntimeInfo } from '@usee/contracts';

export function readRuntimeInfo(): RuntimeInfo {
  return {
    applicationName: app.getName(),
    applicationVersion: app.getVersion(),
    platform: process.platform,
    architecture: process.arch,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
  };
}
