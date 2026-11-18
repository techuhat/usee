import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test, type ElectronApplication } from '@playwright/test';

import type { DesktopBridge } from '@usee/contracts';

import { hostExecutable, launchDesktopApp } from './launch-app';
import { recordSynthetic } from './record';

// A long-duration gate, run on demand (USEE_SOAK=1 npx playwright test ... soak):
// a 30-second recording exported at 1080p30 and at 4K30, each decoded in
// full, with how long it took and the app's peak memory in the annotations.
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
const RECORD_SECONDS = 30;

test.skip(
  process.env['USEE_SOAK'] !== '1' || !existsSync(hostExecutable) || !existsSync(ffmpegPath),
  'The soak gate runs only with USEE_SOAK=1, the recorder host and the FFmpeg runtime.',
);

/** The app's processes' working sets added up, in MB. */
function memoryMb(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ app: electronApp }) =>
    Math.round(
      electronApp.getAppMetrics().reduce((sum, metric) => sum + metric.memory.workingSetSize, 0) /
        1024,
    ),
  );
}

test('exports a long recording at 1080p and 4K, each decoding cleanly', async () => {
  test.setTimeout(30 * 60_000);
  const launched = await launchDesktopApp();
  try {
    const page = await launched.app.firstWindow();
    await recordSynthetic(page, { seconds: RECORD_SECONDS, withTone: true });
    const durationUs = await page.evaluate(() =>
      (window as unknown as { desktop: DesktopBridge }).desktop
        .getProject()
        .then((result) => (result.ok && result.value !== null ? result.value.durationUs : 0)),
    );
    await page.getByTestId('export-open').click();
    const panel = page.getByRole('dialog', { name: 'Export video' });
    await expect(panel.getByTestId('export-start')).toBeEnabled({ timeout: 15_000 });

    for (const [preset, size] of [
      ['mp4-h264-1080p30', '1920x1080'],
      ['mp4-h264-4k30', '3840x2160'],
    ] as const) {
      await panel.getByTestId('export-preset').selectOption(preset);
      const target = path.join(launched.dataDirectory, `${preset}.mp4`);
      await launched.app.evaluate(({ dialog }, file) => {
        dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: file });
      }, target);
      const done = await panel.getByText('Done').count();
      let peakMb = await memoryMb(launched.app);
      const sampler = setInterval(() => {
        void memoryMb(launched.app)
          .then((megabytes) => {
            peakMb = Math.max(peakMb, megabytes);
          })
          .catch(() => undefined);
      }, 2_000);
      const started = Date.now();
      await panel.getByTestId('export-start').click();
      await expect(panel.getByText('Done')).toHaveCount(done + 1, { timeout: 25 * 60_000 });
      const seconds = (Date.now() - started) / 1_000;
      clearInterval(sampler);
      test.info().annotations.push({
        type: `${preset}: export seconds for ${RECORD_SECONDS} s, peak app memory MB`,
        description: `${seconds.toFixed(1)} s (${(RECORD_SECONDS / seconds).toFixed(2)}x real time), ${peakMb} MB`,
      });

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
      expect(info).toContain(size);
      const [, hours, minutes, secondsText] = /Duration: (\d+):(\d+):([\d.]+)/.exec(info) ?? [];
      const exportedUs =
        (Number(hours) * 3_600 + Number(minutes) * 60 + Number(secondsText)) * 1_000_000;
      expect(Math.abs(exportedUs - durationUs)).toBeLessThan(100_000);
    }
  } finally {
    await launched.close();
  }
});
