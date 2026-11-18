import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

import { protocol } from 'electron';

import { parseByteRange } from './project/byte-range';
import { MEDIA_HOST, type MediaFile, type ProjectMedia } from './project/project-media';
import { resolveRendererAsset } from './renderer-assets';
import { RENDERER_SCHEME } from './renderer-origin';
import { buildContentSecurityPolicy } from './security/content-security-policy';

/** Must run before the app is ready. */
export function registerRendererScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: RENDERER_SCHEME,
      // `stream` lets <video> read app://media in ranges as it plays and seeks;
      // `corsEnabled` lets the renderer read the frames it plays (see below).
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        codeCache: true,
        stream: true,
        corsEnabled: true,
      },
    },
  ]);
}

const MEDIA_HEADERS = {
  'Accept-Ranges': 'bytes',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

/** Serves one media file, or the byte range a media element asks for. */
async function serveMedia(
  request: Request,
  file: MediaFile,
  cors: Readonly<Record<string, string>>,
): Promise<Response> {
  const { size } = await stat(file.filePath);
  const range = parseByteRange(request.headers.get('range'), size);
  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { ...MEDIA_HEADERS, ...cors, 'Content-Range': `bytes */${size}` },
    });
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const body =
    request.method === 'HEAD' || size === 0
      ? null
      : Readable.toWeb(createReadStream(file.filePath, { start, end }));
  return new Response(body, {
    status: range === undefined ? 200 : 206,
    headers: {
      ...MEDIA_HEADERS,
      ...cors,
      'Content-Type': file.contentType,
      'Content-Length': String(end - start + 1),
      ...(range === undefined ? {} : { 'Content-Range': `bytes ${start}-${end}/${size}` }),
    },
  });
}

/**
 * `app://renderer/…` serves the bundled renderer; `app://media/…` serves the
 * open project's media (project/project-media.ts). Nothing else resolves.
 * Media allows CORS for the app's own renderer origins only: the preview
 * reads the frames it plays to composite effects over them.
 */
export function registerRendererProtocol(
  rendererRoot: string,
  media: ProjectMedia,
  trustedOrigins: readonly string[],
): void {
  const securityHeaders = {
    'Content-Security-Policy': buildContentSecurityPolicy({ mode: 'production' }),
    'Cross-Origin-Opener-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
  };
  const notFound = () => new Response('Not found', { status: 404, headers: securityHeaders });

  protocol.handle(RENDERER_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: securityHeaders });
    }

    if (new URL(request.url).host === MEDIA_HOST) {
      const file = media.resolve(request.url);
      if (file === undefined) {
        return notFound();
      }
      const origin = request.headers.get('origin');
      const cors =
        origin !== null && trustedOrigins.includes(origin)
          ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
          : { Vary: 'Origin' };
      try {
        return await serveMedia(request, file, cors);
      } catch {
        return notFound();
      }
    }

    const asset = resolveRendererAsset(rendererRoot, request.url);
    if (asset === undefined) {
      return notFound();
    }

    try {
      const body = await readFile(asset.filePath);
      return new Response(body, {
        status: 200,
        headers: { ...securityHeaders, 'Content-Type': asset.contentType },
      });
    } catch {
      return notFound();
    }
  });
}
