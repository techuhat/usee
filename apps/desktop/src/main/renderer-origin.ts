/**
 * Production renderer content is served from this privileged custom scheme
 * instead of file://, so it has a real origin, a CSP header and no access to
 * the rest of the filesystem.
 */
export const RENDERER_SCHEME = 'app';
export const RENDERER_HOST = 'renderer';
export const RENDERER_ORIGIN = `${RENDERER_SCHEME}://${RENDERER_HOST}`;
export const RENDERER_ENTRY_URL = `${RENDERER_ORIGIN}/index.html`;
