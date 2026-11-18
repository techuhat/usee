import { BrowserWindow, screen } from 'electron';

import {
  createAppError,
  err,
  ok,
  REGION_PICKER_HASH,
  type ChosenRegion,
  type CorrelationId,
  type HostDisplay,
  type HostRegion,
  type RegionDrawing,
  type Result,
} from '@usee/contracts';

import type { DesktopEnvironment } from './desktop-environment';
import { rendererWebPreferences } from './main-window';
import { toDisplayRegion } from './region-geometry';

export interface RegionPicker {
  /**
   * Opens the area picker over the display and replies once the user has
   * drawn an area, with it in the display's pixels, or has cancelled (null).
   */
  choose(displayId: string, correlationId: CorrelationId): Promise<Result<ChosenRegion>>;
  /** The picker page's answer. */
  finish(drawing: RegionDrawing): void;
}

interface OpenPicker {
  readonly window: BrowserWindow;
  readonly display: HostDisplay;
  readonly resolve: (region: HostRegion | null) => void;
}

/**
 * The area picker (ADR-009): a transparent window over one display, the
 * app's own page under the same sandbox and content security policy. It
 * only ever returns a rectangle, which main converts to the display's pixels
 * and keeps inside the display before the recorder host sees it.
 */
export function createRegionPicker(options: {
  readonly environment: DesktopEnvironment;
  /** The main window, which owns the picker: closing it closes the picker too. */
  readonly owner: () => BrowserWindow | undefined;
  readonly listDisplays: () => Promise<Result<readonly HostDisplay[]>>;
}): RegionPicker {
  let open: OpenPicker | undefined;

  /** Answers the open picker, if any, and closes its window. */
  function settle(region: HostRegion | null): void {
    const current = open;
    open = undefined;
    if (current === undefined) {
      return;
    }
    current.resolve(region);
    if (!current.window.isDestroyed()) {
      current.window.close();
    }
  }

  return {
    async choose(displayId, correlationId) {
      const displays = await options.listDisplays();
      if (!displays.ok) {
        return displays;
      }
      const display = displays.value.find((candidate) => candidate.id === displayId);
      if (display === undefined) {
        return err(
          createAppError({
            category: 'capture',
            code: 'capture.source-unavailable',
            retryable: true,
            userMessageKey: 'errors.capture.source-unavailable',
            correlationId,
          }),
        );
      }
      settle(null); // one picker at a time

      const { x, y, width, height } = display;
      const bounds = screen.screenToDipRect(null, { x, y, width, height });
      const owner = options.owner();
      const window = new BrowserWindow({
        ...bounds,
        ...(owner === undefined || owner.isDestroyed() ? {} : { parent: owner }),
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        title: 'Choose the area to record',
        webPreferences: rendererWebPreferences(options.environment),
      });
      // Above the taskbar, so the whole display can be chosen.
      window.setAlwaysOnTop(true, 'screen-saver');
      const chosen = new Promise<HostRegion | null>((resolve) => {
        open = { window, display, resolve };
      });
      window.on('closed', () => {
        if (open?.window === window) {
          settle(null);
        }
      });
      window.once('ready-to-show', () => {
        window.setBounds(bounds);
        window.show();
        window.focus();
      });
      window
        .loadURL(`${options.environment.rendererEntryUrl}${REGION_PICKER_HASH}`)
        .catch(() => settle(null));
      return ok({ region: await chosen });
    },

    finish({ area }) {
      const current = open;
      if (current === undefined) {
        return;
      }
      if (area === null) {
        settle(null);
        return;
      }
      const content = current.window.getContentBounds();
      const onScreen = screen.dipToScreenRect(current.window, {
        x: content.x + area.x,
        y: content.y + area.y,
        width: area.width,
        height: area.height,
      });
      settle(toDisplayRegion(onScreen, current.display));
    },
  };
}
