import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import type { DesktopBridge } from '@usee/contracts';
import { decodeManifest } from '@usee/project-format';

import { hostExecutable, launchDesktopApp } from './launch-app';
import { recordSynthetic } from './record';

test.skip(!existsSync(hostExecutable), 'The native recorder host has not been built.');

/** The project's length and its first clip's speed, through the bridge. */
async function shown(page: Page) {
  const json = await page.evaluate(() =>
    (window as unknown as { desktop: DesktopBridge }).desktop.getProject().then((result) =>
      JSON.stringify(
        result.ok && result.value !== null
          ? {
              durationUs: result.value.durationUs,
              speed: result.value.tracks.find((track) => track.kind === 'video')?.clips[0]?.speed,
            }
          : null,
      ),
    ),
  );
  return JSON.parse(json) as { durationUs: number; speed: number };
}

test('plays a clip faster: half as long on the timeline, saved and undoable', async () => {
  test.setTimeout(120_000);
  const launched = await launchDesktopApp();
  try {
    const page = await launched.app.firstWindow();
    const bundle = await recordSynthetic(page, { seconds: 3, withTone: true });
    await page.getByRole('heading', { level: 2 }).click();
    const normal = await shown(page);
    expect(normal.speed).toBe(1);

    // Selected near its start, so the playhead is still inside the clip once it is faster.
    await page
      .getByTestId('timeline-clip')
      .first()
      .click({ position: { x: 40, y: 12 } });
    const panel = page.getByTestId('clip-panel');
    await panel.getByRole('radio', { name: '2×', exact: true }).click();
    await expect.poll(async () => (await shown(page)).speed).toBe(2);
    // At twice the speed the clip takes about half as long.
    const fast = await shown(page);
    expect(fast.durationUs).toBeLessThan(normal.durationUs * 0.55);
    expect(fast.durationUs).toBeGreaterThan(normal.durationUs * 0.45);

    // Playing, the preview moves through the faster clip.
    const canvas = page.getByTestId('preview-canvas');
    await page.getByRole('heading', { level: 2 }).click();
    await page.keyboard.press('Space');
    const from = Number(await canvas.getAttribute('data-frame-us'));
    await expect
      .poll(async () => Number(await canvas.getAttribute('data-frame-us')))
      .toBeGreaterThan(from + 200_000);
    await page.keyboard.press('Space');

    // Undo goes back to normal speed and length; redo returns 2×.
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await shown(page)).speed).toBe(1);
    await page.getByRole('button', { name: 'Redo' }).click();
    await expect.poll(async () => (await shown(page)).speed).toBe(2);

    await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 10_000 });
    const manifest = decodeManifest(await readFile(path.join(bundle, 'manifest.json'), 'utf8'));
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    const video = manifest.value.project.timeline.tracks.find((track) => track.kind === 'video');
    expect(video?.clips[0]?.speed).toBe(2);
  } finally {
    await launched.close();
  }
});
