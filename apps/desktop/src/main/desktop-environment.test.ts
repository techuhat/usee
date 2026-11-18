import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseDevServerOrigin, resolveDesktopEnvironment } from './desktop-environment';

const appPath = path.join('C:', 'apps', 'desktop');

describe('parseDevServerOrigin', () => {
  it.each([
    ['http://127.0.0.1:5173', 'http://127.0.0.1:5173'],
    ['http://localhost:5173/', 'http://localhost:5173'],
    ['http://[::1]:4000', 'http://[::1]:4000'],
  ])('accepts the loopback origin %s', (value, expected) => {
    expect(parseDevServerOrigin(value)).toBe(expected);
  });

  it.each([
    undefined,
    '',
    'not a url',
    'https://127.0.0.1:5173',
    'http://example.com:5173',
    'http://127.0.0.1',
    'http://127.0.0.1:5173/index.html',
    'http://127.0.0.1:5173/?next=https://example.com',
    'http://user:secret@127.0.0.1:5173',
    'file:///C:/Windows/System32',
  ])('ignores %j', (value) => {
    expect(parseDevServerOrigin(value)).toBeUndefined();
  });
});

describe('resolveDesktopEnvironment', () => {
  it('serves the bundled renderer from app:// by default', () => {
    expect(
      resolveDesktopEnvironment({ isPackaged: false, appPath, rendererUrlOverride: undefined }),
    ).toEqual({
      mode: 'production',
      rendererEntryUrl: 'app://renderer/index.html',
      trustedOrigins: ['app://renderer'],
      rendererRoot: path.join(appPath, 'dist', 'renderer'),
      preloadPath: path.join(appPath, 'dist', 'preload', 'preload.cjs'),
    });
  });

  it('uses a loopback dev server only for unpackaged builds', () => {
    const development = resolveDesktopEnvironment({
      isPackaged: false,
      appPath,
      rendererUrlOverride: 'http://127.0.0.1:5173',
    });
    expect(development.mode).toBe('development');
    expect(development.trustedOrigins).toEqual(['http://127.0.0.1:5173']);

    const packaged = resolveDesktopEnvironment({
      isPackaged: true,
      appPath,
      rendererUrlOverride: 'http://127.0.0.1:5173',
    });
    expect(packaged.mode).toBe('production');
    expect(packaged.trustedOrigins).toEqual(['app://renderer']);
  });
});
