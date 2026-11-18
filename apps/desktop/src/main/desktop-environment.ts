import path from 'node:path';

import { RENDERER_ENTRY_URL, RENDERER_ORIGIN } from './renderer-origin';

export interface DesktopEnvironment {
  readonly mode: 'development' | 'production';
  /** What the main window loads. */
  readonly rendererEntryUrl: string;
  /** `scheme://host[:port]` origins allowed to navigate and to call IPC. */
  readonly trustedOrigins: readonly string[];
  readonly rendererRoot: string;
  readonly preloadPath: string;
  readonly devServerOrigin?: string;
  /** usee's icon for an unpackaged window; a packaged one shows its executable's. */
  readonly windowIcon?: string;
}

export interface DesktopEnvironmentInput {
  readonly isPackaged: boolean;
  /** `app.getAppPath()`: the directory holding the desktop package.json. */
  readonly appPath: string;
  /** `ELECTRON_RENDERER_URL`, set only by `npm run dev`. */
  readonly rendererUrlOverride: string | undefined;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Accepts only a bare loopback `http://host:port` origin. Anything else is
 * ignored, so an environment variable can never point the window at remote
 * content.
 */
export function parseDevServerOrigin(value: string | undefined): string | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  const isBareOrigin =
    url.pathname === '/' && url.search === '' && url.hash === '' && url.username === '';
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || url.port === '') {
    return undefined;
  }
  return isBareOrigin && url.password === '' ? url.origin : undefined;
}

export function resolveDesktopEnvironment(input: DesktopEnvironmentInput): DesktopEnvironment {
  const rendererRoot = path.join(input.appPath, 'dist', 'renderer');
  const preloadPath = path.join(input.appPath, 'dist', 'preload', 'preload.cjs');
  // Unpackaged, the executable is Electron's own, with Electron's icon.
  const icon = input.isPackaged
    ? {}
    : { windowIcon: path.join(input.appPath, 'build-resources', 'icon.ico') };

  // A packaged build always serves its own bundled renderer.
  const devServerOrigin = input.isPackaged
    ? undefined
    : parseDevServerOrigin(input.rendererUrlOverride);

  if (devServerOrigin !== undefined) {
    return {
      mode: 'development',
      rendererEntryUrl: `${devServerOrigin}/`,
      trustedOrigins: [devServerOrigin],
      rendererRoot,
      preloadPath,
      devServerOrigin,
      ...icon,
    };
  }

  return {
    mode: 'production',
    rendererEntryUrl: RENDERER_ENTRY_URL,
    trustedOrigins: [RENDERER_ORIGIN],
    rendererRoot,
    preloadPath,
    ...icon,
  };
}
