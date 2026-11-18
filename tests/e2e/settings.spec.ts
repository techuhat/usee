import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import type { DesktopBridge, ProjectSnapshot } from '@usee/contracts';

import { hostExecutable, launchDesktopApp } from './launch-app';
import { recordSynthetic } from './record';

test.skip(!existsSync(hostExecutable), 'The native recorder host has not been built.');

async function openProject(page: Page): Promise<ProjectSnapshot> {
  const result = await page.evaluate(() =>
    (window as unknown as { desktop: DesktopBridge }).desktop.getProject(),
  );
  if (!result.ok || result.value === null) {
    throw new Error(`No project is open: ${JSON.stringify(result)}`);
  }
  return result.value;
}

test('settings shape new recordings, and the 3D camera is one click away', async () => {
  test.setTimeout(180_000);
  const launched = await launchDesktopApp();
  try {
    const page = await launched.app.firstWindow();
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'page');

    // Settings: a 30 fps default, 3D motion and a background for new recordings, 4K exports.
    await nav.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Settings' })).toBeVisible();
    await page.getByRole('radio', { name: '30 fps', exact: true }).click();
    await page.getByLabel('3D motion toward each action').check();
    await page.getByRole('radio', { name: 'Dusk', exact: true }).click();
    await page.getByRole('radio', { name: '4K · 30 fps', exact: true }).click();

    // Saved in the app-data folder, never in a project.
    const settingsFile = path.join(launched.dataDirectory, 'user-data', 'settings.json');
    await expect
      .poll(async () =>
        existsSync(settingsFile)
          ? (JSON.parse(await readFile(settingsFile, 'utf8')) as Record<string, unknown>)
          : null,
      )
      .toMatchObject({
        settingsVersion: 1,
        recording: { frameRate: 30 },
        newProjects: {
          autoZoom: true,
          turn3d: 0.6,
          canvas: { padding: 0.08, background: { kind: 'gradient', from: '#1b2550' } },
        },
        export: { presetId: 'mp4-h264-4k30' },
      });

    // Home starts the next recording from those choices.
    await nav.getByRole('button', { name: 'Home' }).click();
    await expect(page.getByRole('radio', { name: '30 fps', exact: true })).toBeChecked();
    await expect(page.getByLabel('3D motion toward each action')).toBeChecked();
    await recordSynthetic(page, { seconds: 2, withTone: false });

    const project = await openProject(page);
    expect(project.frameRate).toEqual({ numerator: 30, denominator: 1 });
    expect(project.autoZoom).toMatchObject({ enabled: true, turn3d: 0.6 });
    expect(project.canvas).toMatchObject({ padding: 0.08, cornerRadius: 0.03 });

    // The 3D camera tab leads with the moves; with nothing selected, one adds a 3D zoom.
    await page.getByRole('tab', { name: '3D camera' }).click();
    await expect(page.getByTestId('auto-zoom-panel')).toBeVisible();
    await expect(page.getByLabel('Turn toward each action')).toBeChecked();
    await page.getByRole('button', { name: 'Swing' }).click();
    const bar = page.getByTestId('effect-bar');
    await expect(bar).toHaveCount(1);
    await expect(bar).toHaveAttribute('aria-label', /^Zoom 2\.0× in 3D /);
    await expect(bar.getByText('3D', { exact: true })).toBeVisible();
    // The move is one undoable edit.
    await page.getByRole('heading', { level: 2 }).click();
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(bar).toHaveCount(0);

    // The toolbar adds one too.
    await page.getByRole('button', { name: 'Add 3D zoom' }).click();
    await expect(bar).toHaveCount(1);
    await expect(bar).toHaveAttribute('aria-label', / in 3D /);

    // The export panel starts on the remembered quality.
    await page.getByTestId('export-open').click();
    await expect(page.getByTestId('export-preset')).toHaveValue('mp4-h264-4k30');
    await page
      .getByRole('dialog', { name: 'Export video' })
      .getByRole('button', { name: 'Close' })
      .click();

    // Closing returns to Home; Recordings lists the recording and finds it by name.
    await page.getByRole('button', { name: 'Home' }).click();
    await nav.getByRole('button', { name: 'Recordings' }).click();
    const list = page.getByTestId('project-list');
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await page.getByLabel('Find by name').fill('no such name');
    await expect(page.getByText('No recording has that in its name.')).toBeVisible();
    await page.getByLabel('Find by name').fill(project.title.slice(0, 12));
    await expect(list.getByRole('listitem')).toHaveCount(1);
  } finally {
    await launched.close();
  }
});
