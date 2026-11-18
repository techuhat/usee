import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { RENDERER_SCHEME } from '../renderer-origin';

export const MEDIA_HOST = 'media';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
};

export interface MediaFile {
  readonly filePath: string;
  readonly contentType: string;
}

export interface PlayableAsset {
  readonly id: string;
  /** Bundle-relative, already validated by the manifest schema. */
  readonly relativePath: string;
}

/**
 * The open project's media as `app://media/<token>/<asset id>` URLs
 * (docs/security.md, "Safe file policy"). Only that project's managed assets
 * resolve, and only while it is open: every open draws a new token, so a URL
 * kept from an earlier project reaches nothing.
 */
export class ProjectMedia {
  #token: string | undefined;
  #files = new Map<string, MediaFile>();
  #leases = new Map<string, ReadonlyMap<string, MediaFile>>();

  publish(projectRoot: string, assets: readonly PlayableAsset[]): void {
    const root = path.resolve(projectRoot);
    const files = new Map<string, MediaFile>();
    for (const asset of assets) {
      const filePath = path.resolve(root, ...asset.relativePath.split('/'));
      const relative = path.relative(root, filePath);
      const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()];
      if (
        contentType !== undefined &&
        relative !== '' &&
        !relative.startsWith('..') &&
        !path.isAbsolute(relative)
      ) {
        files.set(asset.id, { filePath, contentType });
      }
    }
    this.#token = randomBytes(16).toString('hex');
    this.#files = files;
  }

  clear(): void {
    this.#token = undefined;
    this.#files = new Map();
  }

  /** A media URL set kept alive for an export even if its project closes. */
  leaseAssets(paths: Readonly<Record<string, string>>): {
    readonly urlFor: (assetId: string) => string | undefined;
    readonly release: () => void;
  } {
    const token = randomBytes(16).toString('hex');
    const files = new Map<string, MediaFile>();
    for (const [assetId, filePath] of Object.entries(paths)) {
      const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()];
      if (path.isAbsolute(filePath) && contentType !== undefined) {
        files.set(assetId, { filePath, contentType });
      }
    }
    this.#leases.set(token, files);
    return {
      urlFor: (assetId) =>
        files.has(assetId) ? `${RENDERER_SCHEME}://${MEDIA_HOST}/${token}/${assetId}` : undefined,
      release: () => this.#leases.delete(token),
    };
  }

  /** Where the renderer loads an asset; undefined when it has no playable media. */
  urlFor(assetId: string): string | undefined {
    return this.#token !== undefined && this.#files.has(assetId)
      ? `${RENDERER_SCHEME}://${MEDIA_HOST}/${this.#token}/${assetId}`
      : undefined;
  }

  resolve(requestUrl: string): MediaFile | undefined {
    let url: URL;
    try {
      url = new URL(requestUrl);
    } catch {
      return undefined;
    }
    if (url.protocol !== `${RENDERER_SCHEME}:` || url.host !== MEDIA_HOST) {
      return undefined;
    }
    const [empty, token, assetId, ...rest] = url.pathname.split('/');
    if (empty !== '' || token === undefined || assetId === undefined || rest.length > 0) {
      return undefined;
    }
    const files = token === this.#token ? this.#files : this.#leases.get(token);
    return files?.get(assetId);
  }
}
