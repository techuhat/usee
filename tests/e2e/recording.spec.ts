import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { decodeManifest } from '@usee/project-format';

import { hostExecutable, launchDesktopApp } from './launch-app';
import { chooseSyntheticArea, recordSynthetic } from './record';

// Needs the native host (`npm run build:native`). Records the synthetic test
// pattern, never the real screen.
test.skip(!existsSync(hostExecutable), 'The native recorder host has not been built.');

test('records from the UI and saves one recording as a project', async () => {
  const launched = await launchDesktopApp();
  try {
    const page = await launched.app.firstWindow();
    await expect(page.getByLabel('Microphone')).toHaveValue('');

    const bundle = await recordSynthetic(page, { seconds: 3, withTone: false });
    expect(path.dirname(bundle)).toBe(path.join(launched.dataDirectory, 'projects'));
    await expect(page.getByTestId('timeline-clip')).toHaveCount(1);

    const manifest = decodeManifest(await readFile(path.join(bundle, 'manifest.json'), 'utf8'));
    // Pointer recording is on by default, so the pointer stream comes along as an event asset.
    expect(manifest.ok && manifest.value.project.assets).toEqual([
      expect.objectContaining({ kind: 'video', hasAudio: false }),
      expect.objectContaining({ kind: 'event', eventEncoding: 'jsonl' }),
    ]);

    // Closing the editor returns to Home, where the recording started.
    await page.getByRole('button', { name: 'Home' }).click();
    await expect(page.getByRole('button', { name: 'Start recording' })).toBeEnabled();
  } finally {
    await launched.close();
  }
});

test('records one window at its size, and names it in the project by its ID alone', async () => {
  const launched = await launchDesktopApp();
  try {
    const page = await launched.app.firstWindow();
    const bundle = await recordSynthetic(page, { seconds: 2, withTone: false, source: 'window' });

    const text = await readFile(path.join(bundle, 'manifest.json'), 'utf8');
    const manifest = decodeManifest(text);
    if (!manifest.ok) throw new Error('The manifest did not decode.');
    const session = manifest.value.project.recordingSessions[0];
    expect(session?.sources).toEqual([
      { kind: 'window', windowId: 'window-synthetic', coordinateSpace: 'capture' },
    ]);
    expect(manifest.value.project.assets[0]).toMatchObject({
      kind: 'video',
      dimensions: { width: 960, height: 600 },
    });
    // The window's title was for the picker only: neither the project nor its journal holds it.
    const journal = await readFile(
      path.join(bundle, 'metadata', 'sessions', `${session?.id ?? ''}.journal.ndjson`),
      'utf8',
    );
    expect(text).not.toContain('Synthetic test window');
    expect(journal).toContain('"windowId":"window-synthetic"');
    expect(journal).not.toContain('Synthetic test window');
  } finally {
    await launched.close();
  }
});

test('records an area drawn over a screen, cropped to it', async () => {
  const launched = await launchDesktopApp();
  try {
    const page = await launched.app.firstWindow();
    // The app runs at device scale 1 in E2E, so the picker's pixels are the display's.
    await chooseSyntheticArea(launched.app, page, { x: 100, y: 80 }, { x: 740, y: 440 });
    await expect(page.getByTestId('chosen-area')).toContainText('640 × 360 pixels, from 100, 80');
    const bundle = await recordSynthetic(page, { seconds: 2, withTone: false, source: 'chosen' });

    const manifest = decodeManifest(await readFile(path.join(bundle, 'manifest.json'), 'utf8'));
    if (!manifest.ok) throw new Error('The manifest did not decode.');
    expect(manifest.value.project.recordingSessions[0]?.sources).toEqual([
      {
        kind: 'region',
        coordinateSpace: 'capture',
        region: { x: 100, y: 80, width: 640, height: 360 },
      },
    ]);
    expect(manifest.value.project.assets[0]).toMatchObject({
      kind: 'video',
      dimensions: { width: 640, height: 360 },
    });
  } finally {
    await launched.close();
  }
});
