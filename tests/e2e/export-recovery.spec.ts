import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import type { DesktopBridge } from '@usee/contracts';

import { hostExecutable, launchDesktopApp } from './launch-app';
import { recordSynthetic } from './record';

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

test('an export cut off by a crash is reported, not resumed, and leaves no file', async () => {
  test.setTimeout(240_000);
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'usee-e2e-'));
  const target = path.join(dataDirectory, 'cut-off.mp4');
  try {
    const first = await launchDesktopApp({ dataDirectory });
    const page = await first.app.firstWindow();
    await recordSynthetic(page, { seconds: 3, withTone: true });
    await page.getByTestId('export-open').click();
    const panel = page.getByRole('dialog', { name: 'Export video' });
    await expect(panel.getByTestId('export-start')).toBeEnabled({ timeout: 15_000 });
    await first.app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: file });
    }, target);
    await panel.getByTestId('export-start').click();
    await expect(panel.getByText('Rendering')).toBeVisible({ timeout: 30_000 });

    // The app's main process dies mid-render: no shutdown, no cancellation.
    // (Playwright's own child is a launcher; the app's main process is another.)
    const launcher = first.app.process();
    const exited = new Promise((resolve) => launcher.once('exit', resolve));
    process.kill(await first.app.evaluate(() => process.pid));
    await exited;

    const second = await launchDesktopApp({ dataDirectory });
    try {
      const restarted = await second.app.firstWindow();
      const queue = await restarted.evaluate(() =>
        (window as unknown as { desktop: DesktopBridge }).desktop.getExportQueue(),
      );
      expect(queue.ok).toBe(true);
      const jobs = queue.ok ? queue.value.jobs : [];
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        job: { state: 'failed' },
        error: { code: 'export.interrupted' },
      });
      expect(existsSync(target)).toBe(false);
    } finally {
      await second.close();
    }
  } finally {
    await rm(dataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
});
