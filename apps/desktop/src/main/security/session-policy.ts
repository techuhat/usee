import type { Session } from 'electron';

/**
 * The renderer needs no browser permissions: capture, microphone and input
 * tracking run in the native recorder host, not in web content.
 */
export function denyAllPermissions(
  target: Pick<Session, 'setPermissionCheckHandler' | 'setPermissionRequestHandler'>,
): void {
  target.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);
}

/** Adds the CSP header to responses from the loopback Vite dev server. */
export function applyDevelopmentContentSecurityPolicy(
  target: Session,
  devServerOrigin: string,
  policy: string,
): void {
  target.webRequest.onHeadersReceived({ urls: [`${devServerOrigin}/*`] }, (details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [policy] },
    });
  });
}
