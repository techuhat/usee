import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';

import type { DesktopBridge } from '@usee/contracts';

import { hostExecutable, launchDesktopApp } from './launch-app';
import { recordSynthetic } from './record';

// The development FFmpeg runtime `npm run build:ffmpeg` writes; an unpackaged
// build exports with it (apps/desktop/src/main/export-runtime-source.ts).
const ffmpegPath = path.resolve(
  __dirname,
  '..',
  '..',
  'build',
  'ffmpeg',
  'resources',
  'ffmpeg',
  'ffmpeg.exe',
);

test.skip(
  !existsSync(hostExecutable) || !existsSync(ffmpegPath),
  'Export needs the native recorder host and the FFmpeg runtime (npm run build:ffmpeg).',
);

/** The native save dialog cannot be clicked in a test: main answers it with `filePath`. */
async function answerSaveDialog(app: ElectronApplication, filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: target });
  }, filePath);
}

async function projectDurationUs(page: Page): Promise<number> {
  return page.evaluate(() =>
    (window as unknown as { desktop: DesktopBridge }).desktop
      .getProject()
      .then((result) => (result.ok && result.value !== null ? result.value.durationUs : 0)),
  );
}

test('exports a recording to an MP4 that decodes cleanly, and cancels an export', async () => {
  test.setTimeout(240_000);
  const launched = await launchDesktopApp();
  try {
    const page = await launched.app.firstWindow();
    await recordSynthetic(page, { seconds: 3, withTone: true });
    await page.getByRole('heading', { level: 2 }).click();

    await page.getByTestId('export-open').click();
    const panel = page.getByRole('dialog', { name: 'Export video' });
    // Startup verified and probed the runtime: export is offered.
    await expect(panel.getByTestId('export-start')).toBeEnabled({ timeout: 15_000 });
    await panel.getByTestId('export-preset').selectOption('mp4-h264-1080p30');

    const target = path.join(launched.dataDirectory, 'exported.mp4');
    await answerSaveDialog(launched.app, target);
    const started = Date.now();
    await panel.getByTestId('export-start').click();
    await expect(panel.getByText('Done')).toBeVisible({ timeout: 180_000 });
    const seconds = (Date.now() - started) / 1_000;
    test
      .info()
      .annotations.push({ type: 'export seconds (3 s at 1080p30)', description: `${seconds}` });

    // An MP4 that decodes without an error, as long as the project, H.264 High with AAC.
    const bytes = await readFile(target);
    expect(bytes.subarray(4, 12).toString('latin1')).toBe('ftypisom');
    const decoded = spawnSync(
      ffmpegPath,
      ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-i', target, '-f', 'null', '-'],
      { encoding: 'utf8' },
    );
    expect(decoded.status, decoded.stderr).toBe(0);
    const info = spawnSync(ffmpegPath, ['-hide_banner', '-nostdin', '-i', target], {
      encoding: 'utf8',
    }).stderr;
    expect(info).toMatch(/Video: h264 \(High\)[^\n]*1920x1080/);
    expect(info).toMatch(/Audio: aac/);
    const [, hours, minutes, secondsText] = /Duration: (\d+):(\d+):([\d.]+)/.exec(info) ?? [];
    const durationUs =
      (Number(hours) * 3_600 + Number(minutes) * 60 + Number(secondsText)) * 1_000_000;
    expect(Math.abs(durationUs - (await projectDurationUs(page)))).toBeLessThan(100_000);

    // A second export, canceled at once: it ends canceled and leaves no file.
    const canceled = path.join(launched.dataDirectory, 'canceled.mp4');
    await answerSaveDialog(launched.app, canceled);
    await panel.getByTestId('export-start').click();
    await panel.getByRole('button', { name: 'Cancel' }).first().click();
    await expect(panel.getByText('Canceled')).toBeVisible({ timeout: 60_000 });
    expect(existsSync(canceled)).toBe(false);
  } finally {
    await launched.close();
  }
});
