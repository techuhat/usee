import type { WebContents } from 'electron';

/**
 * Applied to every web contents the app creates: no new windows, no
 * navigation or redirect away from trusted origins, and no <webview>.
 */
export function guardWebContents(
  contents: WebContents,
  isTrustedUrl: (url: string) => boolean,
): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));

  contents.on('will-navigate', (details) => {
    if (!isTrustedUrl(details.url)) {
      details.preventDefault();
    }
  });

  contents.on('will-redirect', (details) => {
    if (!isTrustedUrl(details.url)) {
      details.preventDefault();
    }
  });

  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}
