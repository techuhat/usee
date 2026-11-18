import { existsSync } from 'node:fs';

import { expect, test, type ElectronApplication } from '@playwright/test';

import type { DesktopBridge } from '@usee/contracts';

import { hostExecutable, launchDesktopApp } from './launch-app';

test.skip(!existsSync(hostExecutable), 'The native recorder host has not been built.');

/** The window's state and whether the stop shortcut is held, as main sees them. */
function controls(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow, globalShortcut }) => ({
    minimized: BrowserWindow.getAllWindows()[0]?.isMinimized() ?? false,
    shortcut: globalShortcut.isRegistered('CommandOrControl+Shift+F10'),
  }));
}

test('a recording gets out of the way, and the window comes back with the editor', async () => {
  test.setTimeout(120_000);
  const launched = await launchDesktopApp({ hideWhileRecording: true });
  try {
    const page = await launched.app.firstWindow();
    const screen = page.getByLabel('Screen');
    await expect(screen.locator('option[value="synthetic-0"]')).toHaveCount(1);
    await screen.selectOption('synthetic-0');
    expect(await controls(launched.app)).toEqual({ minimized: false, shortcut: false });

    await page.getByRole('button', { name: 'Start recording' }).click();
    // After the countdown: out of the picture, and stoppable from any app while it runs.
    await expect
      .poll(() => controls(launched.app), { timeout: 20_000 })
      .toEqual({ minimized: true, shortcut: true });
    await page.waitForTimeout(1_500);

    // A test cannot press a global shortcut: it stops as the shortcut does, through main.
    await page.evaluate(() =>
      (window as unknown as { desktop: DesktopBridge }).desktop.stopRecording(),
    );
    await expect
      .poll(() => controls(launched.app), { timeout: 60_000 })
      .toEqual({ minimized: false, shortcut: false });
    await expect(page.getByRole('heading', { level: 2, name: /^Recording / })).toBeVisible({
      timeout: 60_000,
    });
  } finally {
    await launched.close();
  }
});

test('counts down before a recording, and Escape stops the count', async () => {
  test.setTimeout(120_000);
  const launched = await launchDesktopApp();
  try {
    const page = await launched.app.firstWindow();
    const screen = page.getByLabel('Screen');
    await expect(screen.locator('option[value="synthetic-0"]')).toHaveCount(1);
    await screen.selectOption('synthetic-0');
    const phase = () =>
      page.evaluate(() =>
        (window as unknown as { desktop: DesktopBridge }).desktop
          .getRecordingState()
          .then((result) => (result.ok ? result.value.phase : 'unknown')),
      );

    const start = page.getByRole('button', { name: 'Start recording' });
    const countdown = page.getByTestId('countdown');
    await start.click();
    await expect(countdown).toContainText('3');
    await page.keyboard.press('Escape');
    await expect(countdown).toBeHidden();
    // The count was the user's to stop: nothing records once it would have ended.
    await page.waitForTimeout(3_500);
    expect(await phase()).toBe('idle');

    await start.click();
    await expect(countdown).toContainText('3');
    expect(await phase()).toBe('idle');
    await expect(page.getByTestId('recording-status')).toContainText('Recording', {
      timeout: 15_000,
    });
    await expect(countdown).toBeHidden();
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(page.getByRole('heading', { level: 2, name: /^Recording / })).toBeVisible({
      timeout: 60_000,
    });
  } finally {
    await launched.close();
  }
});
