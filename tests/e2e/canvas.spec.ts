import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import type { DesktopBridge } from '@usee/contracts';
import { decodeManifest } from '@usee/project-format';

import { hostExecutable, launchDesktopApp } from './launch-app';
import { recordSynthetic } from './record';

test.skip(!existsSync(hostExecutable), 'The native recorder host has not been built.');

/** The output canvas style the editor currently shows, through the bridge. */
async function canvasOf(page: Page) {
  const json = await page.evaluate(() =>
    (window as unknown as { desktop: DesktopBridge }).desktop
      .getProject()
      .then((result) =>
        JSON.stringify(result.ok && result.value !== null ? result.value.canvas : null),
      ),
  );
  return JSON.parse(json) as {
    aspect: string;
    background: { kind: string };
    shadow: { opacity: number };
  };
}

test('styles the output canvas: shape, background and shadow, saved and undoable', async () => {
  test.setTimeout(120_000);
  const launched = await launchDesktopApp();
  try {
    const page = await launched.app.firstWindow();
    const bundle = await recordSynthetic(page, { seconds: 2, withTone: false });
    await page.getByRole('heading', { level: 2 }).click();
    await page.getByRole('tab', { name: 'Canvas' }).click();
    const panel = page.getByTestId('canvas-panel');
    await expect(panel.getByRole('radio', { name: 'Ink', exact: true })).toBeChecked();

    // A gradient background, a shadow via its slider, then a vertical output.
    await panel.getByRole('radio', { name: 'Dusk', exact: true }).click();
    await expect.poll(async () => (await canvasOf(page)).background.kind).toBe('gradient');

    await panel.getByRole('slider', { name: 'Shadow' }).focus();
    for (let step = 0; step < 4; step += 1) {
      await page.keyboard.press('ArrowRight');
    }
    await page.keyboard.press('Tab');
    await expect.poll(async () => (await canvasOf(page)).shadow.opacity).toBeGreaterThan(0);

    // The shape change is the last edit, so one undo takes it back and one redo returns it.
    await panel.getByRole('radio', { name: '9:16', exact: true }).click();
    await expect.poll(async () => (await canvasOf(page)).aspect).toBe('9:16');
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await canvasOf(page)).aspect).toBe('source');
    await page.getByRole('button', { name: 'Redo' }).click();
    await expect.poll(async () => (await canvasOf(page)).aspect).toBe('9:16');

    // A blurred recording backdrop is project data, like the other canvas choices.
    await panel.getByRole('radio', { name: 'Soft blur', exact: true }).click();
    await expect.poll(async () => (await canvasOf(page)).background.kind).toBe('blurred-source');

    // Motion blur on the picture, backdrop blur, and a spotlight on the cursor are separate sliders.
    const nudge = async (name: string) => {
      await page.getByRole('slider', { name }).focus();
      for (let step = 0; step < 4; step += 1) {
        await page.keyboard.press('ArrowRight');
      }
      await page.keyboard.press('Tab');
    };
    await nudge('Motion blur');
    await nudge('Backdrop blur');
    await page.getByRole('tab', { name: 'Cursor' }).click();
    await nudge('Spotlight');
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as { desktop: DesktopBridge }).desktop
            .getProject()
            .then((result) =>
              result.ok && result.value !== null
                ? (result.value.canvas.motionBlur ?? 0) > 0 &&
                  (result.value.cursor.spotlight ?? 0) > 0
                : false,
            ),
        ),
      )
      .toBe(true);

    // What stands is in the saved manifest.
    await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 10_000 });
    const manifest = decodeManifest(await readFile(path.join(bundle, 'manifest.json'), 'utf8'));
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    const { canvas } = manifest.value.project.settings;
    expect(canvas.aspect).toBe('9:16');
    expect(canvas.background.kind).toBe('blurred-source');
    expect(canvas.shadow.opacity).toBeGreaterThan(0);
    expect(canvas.motionBlur ?? 0).toBeGreaterThan(0);
    expect(manifest.value.project.settings.cursor.spotlight ?? 0).toBeGreaterThan(0);
  } finally {
    await launched.close();
  }
});
