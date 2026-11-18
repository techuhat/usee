import {
  globalShortcut,
  Menu,
  nativeImage,
  Tray,
  type BrowserWindow,
  type NativeImage,
} from 'electron';

import type { RecordingState } from '@usee/contracts';

/**
 * Stops a recording from anywhere. It is registered only while a recording
 * runs, so it takes the keys from other apps for no longer than that, and it
 * listens for this one combination only: keystrokes are never read.
 */
export const STOP_RECORDING_SHORTCUT = 'CommandOrControl+Shift+F10';

export interface RecordingControls {
  /** Follows the recording: the controls appear as it starts and go as it ends. */
  update(phase: RecordingState['phase']): void;
  dispose(): void;
}

export interface RecordingControlsOptions {
  readonly window: () => BrowserWindow | undefined;
  readonly stop: () => void;
  /** Whether the window gets out of the way of what is recorded, as the settings say now. */
  readonly hideWhileRecording: () => boolean;
}

/** A red dot for the tray, drawn here so no image ships for it. */
function recordingDot(): NativeImage {
  const size = 16;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // Coverage of a circle of radius 6 at the centre, smoothed over a pixel's edge.
      const alpha = Math.max(0, Math.min(1, 6.5 - Math.hypot(x + 0.5 - 8, y + 0.5 - 8)));
      const at = (y * size + x) * 4;
      // BGRA: the app's recording red, #dc3045.
      pixels.set([0x45, 0x30, 0xdc, Math.round(alpha * 255)], at);
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size });
}

/**
 * While a recording runs: a shortcut and a tray icon to stop it, and the
 * window minimized so it is not in the picture. As it ends, the window comes
 * back for the editor that opens on it.
 */
export function createRecordingControls(options: RecordingControlsOptions): RecordingControls {
  let tray: Tray | undefined;
  let active = false;
  let hidden = false;

  /** As capture is prepared, so the window has gone before the first frame. */
  const hide = () => {
    const window = options.window();
    if (!hidden && options.hideWhileRecording() && window !== undefined && !window.isDestroyed()) {
      window.minimize();
      hidden = true;
    }
  };

  const begin = () => {
    hide();
    if (active) {
      return;
    }
    active = true;
    // Another app holding the combination only means the tray and window stop it.
    globalShortcut.register(STOP_RECORDING_SHORTCUT, options.stop);
    tray = new Tray(recordingDot());
    tray.setToolTip('usee is recording. Ctrl+Shift+F10 stops it.');
    const menu = Menu.buildFromTemplate([{ label: 'Stop recording', click: options.stop }]);
    tray.setContextMenu(menu);
    tray.on('click', () => tray?.popUpContextMenu());
  };

  const end = (restore: boolean) => {
    if (!active && !hidden) {
      return;
    }
    active = false;
    globalShortcut.unregister(STOP_RECORDING_SHORTCUT);
    tray?.destroy();
    tray = undefined;
    const window = options.window();
    if (restore && hidden && window !== undefined && !window.isDestroyed()) {
      window.restore();
      window.focus();
    }
    hidden = false;
  };

  return {
    update(phase) {
      if (phase === 'preparing') {
        hide();
      } else if (phase === 'recording') {
        begin();
      } else if (phase === 'completed' || phase === 'failed' || phase === 'idle') {
        end(true);
      }
    },
    dispose: () => end(false),
  };
}
