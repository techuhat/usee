import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { decodeManifest } from '@usee/project-format';

import { hostExecutable, launchDesktopApp } from './launch-app';
import { recordSynthetic } from './record';

test.skip(!existsSync(hostExecutable), 'The native recorder host has not been built.');

test('edits a recording, saves the edit and opens it again', async () => {
  const launched = await launchDesktopApp();
  try {
    const page = await launched.app.firstWindow();
    const bundle = await recordSynthetic(page, { seconds: 4, withTone: true });
    const clips = page.getByTestId('timeline-clip');
    await expect(clips).toHaveCount(1);

    // The clip shows the recording's pictures, read from its keyframes in the background.
    const filmstrip = clips.first().getByTestId('clip-filmstrip');
    await expect(filmstrip).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() =>
        filmstrip.evaluate((canvas: HTMLCanvasElement) => {
          const pixels = canvas
            .getContext('2d')
            ?.getImageData(0, 0, canvas.width, canvas.height).data;
          let drawn = 0;
          for (let alpha = 3; alpha < (pixels?.length ?? 0); alpha += 4) {
            if ((pixels?.[alpha] ?? 0) > 0) drawn += 1;
          }
          return drawn / Math.max(1, canvas.width * canvas.height);
        }),
      )
      .toBeGreaterThan(0.9);

    // The preview plays the recording straight from the project over app://media.
    const video = page.getByTestId('preview-video');
    await expect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState), {
        timeout: 15_000,
      })
      .toBeGreaterThanOrEqual(1);
    expect(await video.evaluate((element: HTMLVideoElement) => element.duration)).toBeGreaterThan(
      3,
    );
    await expect(page.locator('canvas.clip-waveform')).toHaveCount(1);

    // Clicking the clip's middle selects it and moves the playhead there; split, then
    // delete the second half.
    await clips.first().click();
    await page.getByRole('button', { name: 'Split' }).click();
    await expect(clips).toHaveCount(2);
    await clips.nth(1).click();
    await page.getByRole('button', { name: 'Delete clip' }).click();
    await expect(clips).toHaveCount(1);

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(clips).toHaveCount(2);
    await page.getByRole('button', { name: 'Redo' }).click();
    await expect(clips).toHaveCount(1);
    await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 10_000 });

    // The edit is on disk: one clip, about the first half of the recording.
    const manifest = decodeManifest(await readFile(path.join(bundle, 'manifest.json'), 'utf8'));
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    const [asset] = manifest.value.project.assets;
    const savedClips = manifest.value.project.timeline.tracks[0]?.clips ?? [];
    expect(savedClips).toHaveLength(1);
    expect(asset?.durationUs).toBeGreaterThan(3_000_000);
    const half = (asset?.durationUs ?? 0) / 2;
    expect(Math.abs((savedClips[0]?.sourceRange.durationUs ?? 0) - half)).toBeLessThan(250_000);

    // Back to Home, where the recording opened from, and open it again: the edit is still there.
    await page.getByRole('button', { name: 'Home' }).click();
    await expect(page.getByTestId('project-list')).toContainText('Recording');
    // The list shows the recording by a picture of it, made while it was open.
    await expect(page.getByTestId('project-list').locator('img.project-thumbnail')).toHaveAttribute(
      'src',
      /^data:image\/jpeg;base64,/,
    );
    await page.getByRole('button', { name: 'Open' }).first().click();
    await expect(clips).toHaveCount(1);

    // Zoomed in, the timeline grows and scrolls along with the playhead; Fit brings it back.
    const timeline = page.getByTestId('timeline');
    const sizes = () =>
      timeline.evaluate((element) => ({
        client: element.clientWidth,
        scroll: element.scrollWidth,
        left: element.scrollLeft,
      }));
    const clipWidth = async () => (await clips.first().boundingBox())?.width ?? 0;
    // Measured once the timeline has laid out at its width.
    await expect.poll(clipWidth).toBeGreaterThan(100);
    const fitted = await clipWidth();
    for (let step = 0; step < 4; step += 1) {
      await page.getByRole('button', { name: 'Zoom the timeline in' }).click();
    }
    // The closest zoom depends on the window's width; any window allows this much.
    await expect.poll(clipWidth).toBeGreaterThan(fitted * 2.5);
    await page.getByRole('heading', { level: 2 }).click();
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(async () => (await sizes()).left).toBeGreaterThan(0);

    // Ctrl and the wheel zoom too, here out.
    const zoomedWidth = (await sizes()).scroll;
    await timeline.scrollIntoViewIfNeeded();
    const area = await timeline.boundingBox();
    await page.mouse.move((area?.x ?? 0) + 200, (area?.y ?? 0) + 40);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, 300);
    await page.keyboard.up('Control');
    await expect.poll(async () => (await sizes()).scroll).toBeLessThan(zoomedWidth);

    await page.getByRole('button', { name: 'Fit' }).click();
    await expect.poll(clipWidth).toBeLessThan(fitted + 1);
    const fittedSizes = await sizes();
    expect(fittedSizes.scroll).toBeLessThanOrEqual(fittedSizes.client + 1);
  } finally {
    await launched.close();
  }
});
