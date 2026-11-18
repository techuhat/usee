import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import type { DesktopBridge } from '@usee/contracts';
import { decodeManifest } from '@usee/project-format';

import { hostExecutable, launchDesktopApp } from './launch-app';
import { recordSynthetic } from './record';

test.skip(!existsSync(hostExecutable), 'The native recorder host has not been built.');

/** What the editor shows of the generated camera and the clips' own zooms, through the bridge. */
interface Shown {
  readonly autoZoom: { readonly enabled: boolean; readonly disabled: readonly string[] };
  readonly generated: readonly string[];
  readonly zooms: readonly {
    readonly range: { readonly startUs: number; readonly durationUs: number };
    readonly poses: readonly { readonly value: { readonly scale: number } }[];
  }[];
}

async function shown(page: Page): Promise<Shown> {
  const json = await page.evaluate(() =>
    (window as unknown as { desktop: DesktopBridge }).desktop.getProject().then((result) =>
      JSON.stringify(
        result.ok && result.value !== null
          ? {
              autoZoom: result.value.autoZoom,
              generated: result.value.assets.flatMap(
                (asset) => asset.pointer?.autoZooms.map((zoom) => zoom.id) ?? [],
              ),
              zooms: result.value.tracks.flatMap((track) =>
                track.clips.flatMap((clip) =>
                  clip.effects.filter((effect) => effect.kind === 'zoom'),
                ),
              ),
            }
          : null,
      ),
    ),
  );
  return JSON.parse(json) as Shown;
}

test('zooms in on clicks, and lets a generated zoom be turned off or taken over', async () => {
  test.setTimeout(120_000);
  const launched = await launchDesktopApp();
  try {
    const page = await launched.app.firstWindow();
    const bundle = await recordSynthetic(page, { seconds: 4, withTone: false });
    await page.getByRole('heading', { level: 2 }).click();
    const autoBars = page.getByTestId('auto-zoom-bar');
    const effectBars = page.getByTestId('effect-bar');
    const inspector = page.getByTestId('effect-inspector');

    // The synthetic pointer clicks once a second: close enough together for one zoom.
    await expect(autoBars).toHaveCount(1);
    await page.getByRole('tab', { name: 'Camera' }).click();
    await expect(page.getByTestId('auto-zoom-panel')).toContainText('1 zoom follows your clicks');
    const [zoomId] = (await shown(page)).generated;
    expect(zoomId).toBeDefined();

    // Selected, it can be turned off and, by undo, back on.
    await autoBars.first().click();
    await expect(inspector.getByRole('heading', { name: 'Automatic zoom' })).toBeVisible();
    await inspector.getByLabel('Use this zoom').uncheck();
    await expect(autoBars.first()).toHaveClass(/\boff\b/);
    expect((await shown(page)).autoZoom.disabled).toEqual([zoomId]);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(autoBars.first()).not.toHaveClass(/\boff\b/);

    // Taken over, it becomes the clip's own zoom, selected, in one step.
    await inspector.getByRole('button', { name: 'Edit as my own zoom' }).click();
    await expect(effectBars).toHaveCount(1);
    await expect(inspector.getByRole('heading', { name: 'Zoom' })).toBeVisible();
    await expect(autoBars.first()).toHaveClass(/\boff\b/);
    const [own] = (await shown(page)).zooms;
    expect(own?.poses.length).toBeGreaterThan(1);
    expect(own?.poses.every((pose) => pose.value.scale === 2)).toBe(true);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(effectBars).toHaveCount(0);
    await expect(autoBars.first()).not.toHaveClass(/\boff\b/);

    // Off for the whole project, the generated zooms leave the timeline.
    await page.getByRole('tab', { name: 'Camera' }).click();
    await page.getByLabel('Zoom in on clicks').uncheck();
    await expect(autoBars).toHaveCount(0);
    await expect(page.getByTestId('auto-zoom-panel')).toContainText('Turned off');
    await expect(page.getByLabel('Depth')).toBeDisabled();

    // The run and its provenance, and the overrides, are in the saved manifest.
    await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 10_000 });
    const manifest = decodeManifest(await readFile(path.join(bundle, 'manifest.json'), 'utf8'));
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    const { project } = manifest.value;
    expect(project.settings.autoZoom).toEqual({ enabled: false, scale: 2, disabled: [] });
    expect(project.analysisRuns).toHaveLength(1);
    expect(project.analysisRuns[0]?.provenance).toMatchObject({
      strategy: 'pointer-focus',
      strategyVersion: 1,
    });
    expect(project.analysisRuns[0]?.provenance.inputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(project.analysisRuns[0]?.zooms.map((zoom) => zoom.id)).toEqual([zoomId]);
  } finally {
    await launched.close();
  }
});
