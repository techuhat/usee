import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveRendererAsset } from './renderer-assets';

const root = path.resolve('fixture-root', 'dist', 'renderer');

describe('resolveRendererAsset', () => {
  it('serves the entry document for the bare origin and index.html', () => {
    const expected = {
      filePath: path.join(root, 'index.html'),
      contentType: 'text/html; charset=utf-8',
    };
    expect(resolveRendererAsset(root, 'app://renderer/')).toEqual(expected);
    expect(resolveRendererAsset(root, 'app://renderer/index.html')).toEqual(expected);
  });

  it('serves nested assets with a content type', () => {
    expect(resolveRendererAsset(root, 'app://renderer/assets/index-abc.js?v=1')).toEqual({
      filePath: path.join(root, 'assets', 'index-abc.js'),
      contentType: 'text/javascript; charset=utf-8',
    });
  });

  it.each(['app://renderer/../../secrets.json', 'app://renderer/%2e%2e/%2e%2e/secrets.json'])(
    'clamps the dot segments in %s at the root, as the URL parser resolves them',
    (url) => {
      expect(resolveRendererAsset(root, url)?.filePath).toBe(path.join(root, 'secrets.json'));
    },
  );

  it.each([
    'app://renderer/..%5c..%5csecrets.json',
    'app://renderer/assets/..%2f..%2f..%2fsecrets.json',
    'app://renderer/C:/Windows/win.ini',
    'app://renderer/%00.js',
    'app://renderer/%E0%A4%A.js',
  ])('refuses %s, which tries to leave the renderer root', (url) => {
    expect(resolveRendererAsset(root, url)).toBeUndefined();
  });

  it.each([
    'app://other/index.html',
    'file:///C:/index.html',
    'https://renderer/index.html',
    'app://renderer/assets/tool.exe',
    'app://renderer/assets',
    'not a url',
  ])('refuses %s', (url) => {
    expect(resolveRendererAsset(root, url)).toBeUndefined();
  });
});
