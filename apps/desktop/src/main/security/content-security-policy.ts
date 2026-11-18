export type ContentSecurityPolicyOptions =
  | { readonly mode: 'production' }
  | { readonly mode: 'development'; readonly devServerOrigin: string };

type Directives = Readonly<Record<string, readonly string[]>>;

/** Everything the bundled renderer needs and nothing else; no eval, no remote origins. */
const PRODUCTION_DIRECTIVES: Directives = {
  'default-src': ["'none'"],
  'script-src': ["'self'"],
  'style-src': ["'self'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'font-src': ["'self'"],
  // Export's worker reads the open project's recordings in byte ranges to decode them in order.
  'connect-src': ["'self'", 'app://media'],
  // The open project's media (main/project/project-media.ts).
  'media-src': ["'self'", 'blob:', 'app://media'],
  'worker-src': ["'self'"],
  'manifest-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
  'frame-ancestors': ["'none'"],
};

function serialize(directives: Directives): string {
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ');
}

/**
 * The development policy additionally allows what the Vite dev server needs:
 * the inline React Refresh preamble, injected <style> tags and the HMR socket.
 * It is only ever applied to the loopback dev server.
 */
export function buildContentSecurityPolicy(options: ContentSecurityPolicyOptions): string {
  if (options.mode === 'production') {
    return serialize(PRODUCTION_DIRECTIVES);
  }

  const socketOrigin = options.devServerOrigin.replace(/^http/, 'ws');
  return serialize({
    ...PRODUCTION_DIRECTIVES,
    'script-src': ["'self'", "'unsafe-inline'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'connect-src': ["'self'", 'app://media', socketOrigin],
  });
}
