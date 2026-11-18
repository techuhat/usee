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
      await expect(page.getByRole('dialog', { name: 'Welcome to usee' })).toBeVisible();

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

      // The last step chooses the looks new recordings start with; Done closes the tour for good.
      await last.getByRole('radio', { name: 'Dusk', exact: true }).click();
      await last.getByRole('button', { name: 'Done' }).click();
      await expect(tour).toBeHidden();
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

      // Settings opens it again, and Escape closes it.
      await page
        .getByRole('navigation', { name: 'Main' })
        .getByRole('button', { name: 'Settings' })
        .click();
      await page.getByRole('button', { name: 'Show the welcome tour' }).click();
      await expect(page.getByRole('dialog', { name: 'Welcome to usee' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(tour).toBeHidden();
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
