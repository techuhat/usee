import type { DesktopBridge } from '@usee/contracts';

declare global {
  interface Window {
    /** Exposed by preload; the renderer's only route to desktop capabilities. */
    readonly desktop: DesktopBridge;
  }
}

export {};
