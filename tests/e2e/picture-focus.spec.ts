import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import type { DesktopBridge } from '@usee/contracts';

import { hostExecutable, launchDesktopApp } from './launch-app';
import { recordSynthetic } from './record';

test.skip(!existsSync(hostExecutable), 'The native recorder host has not been built.');

/** The strategy the saved manifest's camera run names, once the session has saved it. */
async function savedStrategy(projectPath: string): Promise<string | undefined> {
  const manifest = JSON.parse(await readFile(path.join(projectPath, 'manifest.json'), 'utf8')) as {
    project: { analysisRuns: { provenance: { strategy: string } }[] };
  };
  return manifest.project.analysisRuns[0]?.provenance.strategy;
}

async function recordingAssetId(page: Page): Promise<string> {
  const project = await page.evaluate(() =>
    (window as unknown as { desktop: DesktopBridge }).desktop.getProject(),
  );
  const asset =
    project.ok && project.value !== null
      ? project.value.assets.find(
          (candidate) => candidate.kind === 'video' && candidate.pointer !== null,
        )
      : undefined;
  if (asset === undefined) throw new Error('The recording has no video with a pointer.');
  return asset.id;
}

test('the camera follows changes on screen once the editor has read the picture', async () => {
  test.setTimeout(180_000);
  const launched = await launchDesktopApp();
  try {
    const page = await launched.app.firstWindow();
    const projectPath = await recordSynthetic(page, { seconds: 3, withTone: false });
    await expect.poll(() => savedStrategy(projectPath)).toBe('pointer-focus');

    await page.getByRole('tab', { name: '3D camera' }).click();
    const status = page.getByTestId('picture-focus-status');
    await page.getByLabel('Follow changes on screen').check();
    await expect(status).toHaveText('The camera also looks where the picture changes.', {
      timeout: 90_000,
    });

    // What it found is derived data in the bundle: the synthetic box jumping along its row.
    const file = path.join(
      projectPath,
      'derived',
      'picture-changes',
      `${await recordingAssetId(page)}.json`,
    );
    const picture = JSON.parse(await readFile(file, 'utf8')) as {
      format: string;
      algorithm: string;
      changes: { y: number }[];
    };
    expect(picture).toMatchObject({ format: 'usee.picture-changes', algorithm: 'cell-luma-v1' });
    expect(picture.changes.length).toBeGreaterThan(0);
    // The box spans rows 280-440 of 720: its changes sit in that band.
    for (const change of picture.changes) {
      expect(change.y).toBeGreaterThan(0.3);
      expect(change.y).toBeLessThan(0.7);
    }
    await expect.poll(() => savedStrategy(projectPath)).toBe('pointer-picture-focus');

    // A setting for every recording, saved with the rest.
    const settingsFile = path.join(launched.dataDirectory, 'user-data', 'settings.json');
    expect(JSON.parse(await readFile(settingsFile, 'utf8'))).toMatchObject({
      analysis: { pictureFocus: true },
    });

    // Off again: the camera follows the pointer alone.
    await page.getByLabel('Follow changes on screen').uncheck();
    await expect.poll(() => savedStrategy(projectPath)).toBe('pointer-focus');
  } finally {
    await launched.close();
  }
});
