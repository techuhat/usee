import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { launchDesktopApp } from './launch-app';

test('a first start opens the welcome tour once, and Settings shows it again', async () => {
  test.setTimeout(120_000);
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'usee-e2e-welcome-'));
  try {
    const first = await launchDesktopApp({ dataDirectory, welcome: true });
    try {
      const page = await first.app.firstWindow();
      const tour = page.getByRole('dialog');
      // It opens once the settings have loaded; a first start after a build can be slow.
      await expect(page.getByRole('dialog', { name: 'Welcome to usee' })).toBeVisible({
        timeout: 20_000,
      });

      // Next and the arrow keys step through it; a step's dot goes straight there.
      await tour.getByRole('button', { name: 'Next' }).click();
      await expect(page.getByRole('dialog', { name: 'Screen, window or area' })).toBeVisible();
      await page.keyboard.press('ArrowRight');
      await expect(
        page.getByRole('dialog', { name: 'Your recordings stay with you' }),
      ).toBeVisible();
      await page.keyboard.press('ArrowLeft');
      await expect(page.getByRole('dialog', { name: 'Screen, window or area' })).toBeVisible();
      await tour.getByRole('button', { name: /^Step 4 of 4/ }).click();
      const last = page.getByRole('dialog', { name: 'Choose how recordings start' });
      await expect(last).toBeVisible();

      // The last step chooses the looks new recordings start with; Done closes the tour.
      await last.getByRole('radio', { name: 'Dusk', exact: true }).click();
      await last.getByRole('button', { name: 'Done' }).click();

      // Settings opens it again, even straight after it closed, and it stays open (a tour
      // closing a moment before once closed the one opened after it); Escape closes it.
      await page
        .getByRole('navigation', { name: 'Main' })
        .getByRole('button', { name: 'Settings' })
        .click();
      await page.getByRole('button', { name: 'Show the welcome tour' }).click();
      const again = page.getByRole('dialog', { name: 'Welcome to usee' });
      await expect(again).toBeVisible();
      await page.waitForTimeout(600);
      await expect(again).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(tour).toBeHidden();

      // Closing it saved that it was seen, and the looks chosen on its last step.
      const settingsFile = path.join(dataDirectory, 'user-data', 'settings.json');
      await expect
        .poll(async () =>
          existsSync(settingsFile)
            ? (JSON.parse(await readFile(settingsFile, 'utf8')) as Record<string, unknown>)
            : null,
        )
        .toMatchObject({
          welcome: { seen: true },
          newProjects: { canvas: { background: { kind: 'gradient', from: '#1b2550' } } },
        });
    } finally {
      await first.close();
    }

    // The next start goes straight to Home.
    const again = await launchDesktopApp({ dataDirectory, welcome: true });
    try {
      const page = await again.app.firstWindow();
      await expect(page.getByRole('button', { name: 'Start recording' })).toBeVisible();
      await page.waitForTimeout(2_000);
      await expect(page.getByRole('dialog')).toHaveCount(0);
    } finally {
      await again.close();
    }
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
