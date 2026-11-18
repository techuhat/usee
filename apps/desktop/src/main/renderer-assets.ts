import path from 'node:path';

import { RENDERER_HOST, RENDERER_SCHEME } from './renderer-origin';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export interface RendererAsset {
  readonly filePath: string;
  readonly contentType: string;
}

/**
 * Maps an `app://renderer/...` URL to a file inside `rendererRoot`. Returns
 * `undefined` for other hosts, unknown file types, and any path that would
 * resolve outside the root (`..`, encoded separators, drive letters).
 */
export function resolveRendererAsset(
  rendererRoot: string,
  requestUrl: string,
): RendererAsset | undefined {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== `${RENDERER_SCHEME}:` || url.host !== RENDERER_HOST) {
    return undefined;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  if (pathname.includes('\0')) {
    return undefined;
  }

  const root = path.resolve(rendererRoot);
  const relativeRequest = pathname === '/' ? 'index.html' : pathname.replace(/^[/\\]+/, '');
  const filePath = path.resolve(root, relativeRequest);
  const relativeToRoot = path.relative(root, filePath);
  if (relativeToRoot === '' || relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    return undefined;
  }

  const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()];
  return contentType === undefined ? undefined : { filePath, contentType };
}
