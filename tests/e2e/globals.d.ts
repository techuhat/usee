import type { DesktopBridge } from '@usee/contracts';

// Mirrors apps/desktop/src/renderer/environment.d.ts for code evaluated in the page.
declare global {
  interface Window {
    readonly desktop: DesktopBridge;
  }
}

export {};
