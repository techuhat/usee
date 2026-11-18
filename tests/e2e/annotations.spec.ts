import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import type { AnnotationShapeDto, DesktopBridge } from '@usee/contracts';
import { decodeManifest } from '@usee/project-format';

import { hostExecutable, launchDesktopApp } from './launch-app';
import { recordSynthetic } from './record';

test.skip(!existsSync(hostExecutable), 'The native recorder host has not been built.');

/** The shape of the clip's annotation, as the editor shows the project. */
async function annotationShape(page: Page): Promise<AnnotationShapeDto | undefined> {
  const json = await page.evaluate(() =>
    (window as unknown as { desktop: DesktopBridge }).desktop.getProject().then((result) => {
      const effects =
        result.ok && result.value !== null
          ? result.value.tracks.flatMap((track) => track.clips.flatMap((clip) => clip.effects))
          : [];
      const found = effects.find((effect) => effect.kind === 'annotation');
      return JSON.stringify(found?.kind === 'annotation' ? found.shape : null);
    }),
  );
  return (JSON.parse(json) as AnnotationShapeDto | null) ?? undefined;
}

/** How many pixels of the preview are the annotation's green, which the synthetic pattern has none of. */
async function greenPixels(page: Page): Promise<number> {
  return page.getByTestId('preview-canvas').evaluate((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext('2d');
    if (context === null) {
      return -1;
    }
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let count = 0;
    for (let at = 0; at < data.length; at += 4) {
      const [red = 0, green = 0, blue = 0] = [data[at], data[at + 1], data[at + 2]];
      if (Math.abs(red - 52) < 24 && Math.abs(green - 199) < 24 && Math.abs(blue - 89) < 24) {
        count += 1;
      }
    }
    return count;
  });
}

/** Drags a handle by a share of the overlay's size. */
async function dragBy(page: Page, handle: Locator, dx: number, dy: number): Promise<void> {
  const overlay = await page
    .getByTestId('annotation-overlay')
    .or(page.getByTestId('annotation-box'))
    .first()
    .boundingBox();
  const start = await handle.boundingBox();
  if (overlay === null || start === null) {
    throw new Error('The handle is not visible.');
  }
  const x = start.x + start.width / 2;
  const y = start.y + start.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx * overlay.width, y + dy * overlay.height, { steps: 5 });
  await page.mouse.up();
}

test('annotates the picture with words, an arrow and a box, in preview and in the project', async () => {
  test.setTimeout(150_000);
  const launched = await launchDesktopApp();
  try {
    const page = await launched.app.firstWindow();
    const bundle = await recordSynthetic(page, { seconds: 2, withTone: false });

    // T adds words at the playhead, half a second in, selected, with handles over the picture.
    await page.getByRole('heading', { level: 2 }).click();
    for (let frame = 0; frame < 30; frame += 1) {
      await page.keyboard.press('ArrowRight');
    }
    await page.keyboard.press('t');
    const inspector = page.getByTestId('effect-inspector');
    await expect(inspector.getByRole('heading', { name: 'Annotation' })).toBeVisible();
    await expect(page.getByTestId('annotation-handle-words')).toBeVisible();
    await expect
      .poll(() => annotationShape(page))
      .toMatchObject({ kind: 'text', text: 'Your text' });

    // The words, typed as one edit, in green; the shortcut keys type into the field.
    const words = inspector.getByLabel('Words');
    await words.fill('Click Save to keep it');
    await words.press('Enter');
    await expect
      .poll(() => annotationShape(page))
      .toMatchObject({ kind: 'text', text: 'Click Save to keep it' });
    await inspector.getByRole('radio', { name: 'Green', exact: true }).click();
    await expect.poll(async () => (await annotationShape(page))?.color).toBe('#34c759');

    // Moved by its handle over the picture.
    await dragBy(page, page.getByTestId('annotation-handle-words'), 0.2, 0.3);
    await expect
      .poll(async () => {
        const shape = await annotationShape(page);
        return shape?.kind === 'text' ? shape.at.y : 0;
      })
      .toBeGreaterThan(0.4);

    // An arrow at the same place, its point dragged.
    await inspector.getByRole('radio', { name: 'Arrow', exact: true }).click();
    await expect.poll(async () => (await annotationShape(page))?.kind).toBe('arrow');
    const before = await annotationShape(page);
    await dragBy(page, page.getByTestId('annotation-handle-point'), -0.1, -0.1);
    await expect
      .poll(async () => {
        const shape = await annotationShape(page);
        return shape?.kind === 'arrow' && before?.kind === 'arrow'
          ? shape.to.x < before.to.x
          : false;
      })
      .toBe(true);

    // A box, which the preview draws once nothing is selected.
    await inspector.getByRole('radio', { name: 'Box', exact: true }).click();
    await expect.poll(async () => (await annotationShape(page))?.kind).toBe('box');
    await expect(page.getByTestId('effect-bar').filter({ hasText: 'Box' })).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect.poll(() => greenPixels(page), { timeout: 10_000 }).toBeGreaterThan(200);

    // Off, it leaves the picture as recorded.
    await page.getByTestId('effect-bar').filter({ hasText: 'Box' }).click();
    await inspector.getByLabel('Use this annotation').uncheck();
    await page.keyboard.press('Escape');
    await expect.poll(() => greenPixels(page), { timeout: 10_000 }).toBe(0);

    // Saved in the project, which a build that knows annotations reads back.
    await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 15_000 });
    const manifest = decodeManifest(await readFile(path.join(bundle, 'manifest.json'), 'utf8'));
    if (!manifest.ok) throw new Error('The manifest did not decode.');
    const saved = manifest.value.project.timeline.tracks
      .flatMap((track) => track.clips.flatMap((clip) => clip.effects))
      .find((effect) => effect.kind === 'annotation');
    expect(saved).toMatchObject({
      kind: 'annotation',
      enabled: false,
      shape: { kind: 'box', color: '#34c759' },
    });
  } finally {
    await launched.close();
  }
});
