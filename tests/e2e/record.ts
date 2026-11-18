import { expect, type ElectronApplication, type Page } from '@playwright/test';

import type { DesktopBridge } from '@usee/contracts';

/**
 * Chooses an area of the synthetic display on the area picker: drags from
 * `from` to `to`, in the picker's CSS pixels, and records that area.
 */
export async function chooseSyntheticArea(
  app: ElectronApplication,
  page: Page,
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
): Promise<void> {
  await page.getByRole('radio', { name: 'Area', exact: true }).click();
  const screen = page.getByLabel('Screen');
  await expect(screen.locator('option[value="synthetic-0"]')).toHaveCount(1);
  await screen.selectOption('synthetic-0');

  const opened = app.waitForEvent('window');
  await page.getByRole('button', { name: 'Choose area' }).click();
  const picker = await opened;
  await expect(picker.getByTestId('region-picker')).toBeVisible();
  await picker.mouse.move(from.x, from.y);
  await picker.mouse.down();
  await picker.mouse.move(to.x, to.y, { steps: 4 });
  await picker.mouse.up();
  await picker.getByRole('button', { name: 'Record this area' }).click();
  await expect(page.getByTestId('chosen-area')).toContainText('pixels');
}

/**
 * Records the synthetic test pattern (and, with `withTone`, the synthetic
 * test tone) through the recording panel, then waits for the editor that
 * opens on the saved project. Returns the project bundle's path. `source`
 * picks the synthetic display (the default) or the synthetic window, or
 * keeps what the record card already has (`chosen`).
 */
export async function recordSynthetic(
  page: Page,
  {
    seconds,
    withTone,
    source = 'display',
  }: {
    readonly seconds: number;
    readonly withTone: boolean;
    readonly source?: 'display' | 'window' | 'chosen';
  },
): Promise<string> {
  if (source === 'window') {
    await page.getByRole('radio', { name: 'Window', exact: true }).click();
    const picker = page.getByLabel('Window', { exact: true });
    await expect(picker.locator('option[value="window-synthetic"]')).toHaveCount(1);
    await picker.selectOption('window-synthetic');
  } else if (source === 'display') {
    const screen = page.getByLabel('Screen');
    await expect(screen.locator('option[value="synthetic-0"]')).toHaveCount(1);
    await screen.selectOption('synthetic-0');
  }
  if (withTone) {
    await page.getByLabel('Microphone').selectOption('synthetic-audio');
  }

  await page.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByTestId('recording-status')).toContainText('Recording', {
    timeout: 15_000,
  });
  await page.waitForTimeout(seconds * 1_000);
  await page.getByRole('button', { name: 'Stop recording' }).click();

  // A finished recording opens straight in the editor.
  await expect(page.getByRole('heading', { level: 2, name: /^Recording / })).toBeVisible({
    timeout: 60_000,
  });

  const state = await page.evaluate(() =>
    (window as unknown as { desktop: DesktopBridge }).desktop.getRecordingState(),
  );
  if (!state.ok || state.value.phase !== 'completed') {
    throw new Error(`The recording did not complete: ${JSON.stringify(state)}`);
  }
  return state.value.projectPath;
}
