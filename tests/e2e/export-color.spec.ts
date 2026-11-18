import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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

test('an export shows the recording’s colours, a saturated yellow included', async () => {
  test.setTimeout(240_000);
  const launched = await launchDesktopApp();
  try {
    const page = await launched.app.firstWindow();
    await recordSynthetic(page, { seconds: 2, withTone: false });
    // No zoom: the export is the recording scaled to 1080p, so places line up.
    await page.getByRole('tab', { name: '3D camera' }).click();
    await page.getByLabel('Zoom in on clicks').uncheck();
    await page.getByTestId('export-open').click();
    const panel = page.getByRole('dialog', { name: 'Export video' });
    await expect(panel.getByTestId('export-start')).toBeEnabled({ timeout: 15_000 });
    await panel.getByTestId('export-preset').selectOption('mp4-h264-1080p30');
    const target = path.join(launched.dataDirectory, 'exported.mp4');
    await launched.app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: file });
    }, target);
    await panel.getByTestId('export-start').click();
    await expect(panel.getByText('Done')).toBeVisible({ timeout: 180_000 });

    // Both played back as the editor plays them, half a second in, small.
    const exported = (await readFile(target)).toString('base64');
    const samples = await page.evaluate(async (base64) => {
      const desktop = (window as unknown as { desktop: DesktopBridge }).desktop;
      const project = await desktop.getProject();
      const source = project.ok
        ? project.value?.assets.find((asset) => asset.kind === 'video')
        : undefined;
      if (source === undefined) throw new Error('The project has no recording.');
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const frameOf = async (url: string) => {
        const video = document.createElement('video');
        video.crossOrigin = 'anonymous';
        video.muted = true;
        video.src = url;
        document.body.append(video);
        await new Promise((resolve) =>
          video.addEventListener('loadeddata', resolve, { once: true }),
        );
        await new Promise((resolve) => {
          video.requestVideoFrameCallback(() => resolve(undefined));
          video.currentTime = 0.5;
        });
        const context = new OffscreenCanvas(320, 180).getContext('2d');
        if (context === null) throw new Error('No canvas.');
        context.drawImage(video, 0, 0, 320, 180);
        video.remove();
        return context.getImageData(0, 0, 320, 180).data;
      };
      const recording = await frameOf(source.mediaUrl);
      const exportedFrame = await frameOf(
        URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' })),
      );
      const at = (data: Uint8ClampedArray, x: number, y: number) =>
        Array.from(data.subarray((y * 320 + x) * 4, (y * 320 + x) * 4 + 3));
      // The synthetic source's yellow box, wherever it is half a second in.
      let count = 0;
      let sumX = 0;
      let sumY = 0;
      for (let y = 0; y < 180; y += 1) {
        for (let x = 0; x < 320; x += 1) {
          const [red = 0, green = 0, blue = 0] = at(recording, x, y);
          if (red > 180 && green > 130 && blue < 120) {
            count += 1;
            sumX += x;
            sumY += y;
          }
        }
      }
      const box = [Math.round(sumX / Math.max(1, count)), Math.round(sumY / Math.max(1, count))];
      const places = { tile: [10, 10], background: [30, 10], box };
      return Object.fromEntries(
        Object.entries(places).map(([name, [x = 0, y = 0]]) => [
          name,
          { recording: at(recording, x, y), exported: at(exportedFrame, x, y) },
        ]),
      );
    }, exported);

    // Within compression's reach, every channel: a mismatched colour matrix
    // moved the yellow by 5-7 levels.
    for (const { recording, exported: played } of Object.values(samples)) {
      recording.forEach((level, channel) => {
        expect(Math.abs((played[channel] ?? 0) - level)).toBeLessThanOrEqual(3);
      });
    }
    expect(samples['box']?.recording[0]).toBeGreaterThan(200);
  } finally {
    await launched.close();
  }
});
