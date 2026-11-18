import { describe, expect, it } from 'vitest';

import { isTrustedUrl, originOf } from './trusted-origin';

describe('trusted origins', () => {
  it('rebuilds the origin of custom schemes, which WHATWG reports as "null"', () => {
    expect(new URL('app://renderer/index.html').origin).toBe('null');
    expect(originOf('app://renderer/index.html')).toBe('app://renderer');
    expect(originOf('http://127.0.0.1:5173/src/main.tsx')).toBe('http://127.0.0.1:5173');
  });

  it.each([
    ['app://renderer/index.html', true],
    ['app://renderer/assets/x.js', true],
    ['app://renderer.evil/index.html', false],
    ['app://other/index.html', false],
    ['https://renderer/index.html', false],
    ['file:///C:/index.html', false],
    ['about:blank', false],
    ['not a url', false],
  ])('treats %s as trusted: %s', (url, expected) => {
    expect(isTrustedUrl(url, ['app://renderer'])).toBe(expected);
  });
});
