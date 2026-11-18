import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import type { DesktopBridge } from '@usee/contracts';
import { decodeManifest } from '@usee/project-format';

import { hostExecutable, launchDesktopApp } from './launch-app';
import { recordSynthetic } from './record';

test.skip(!existsSync(hostExecutable), 'The native recorder host has not been built.');

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** What the editor shows of the open project, through the public bridge. */
interface Shown {
  readonly cursor: { readonly visible: boolean; readonly clickEffect: string };
  readonly effects: readonly {
    readonly kind: string;
    readonly range: { readonly startUs: number; readonly durationUs: number };
    readonly poses?: readonly {
      readonly timestampUs: number;
      readonly value: {
        readonly anchor: { readonly x: number; readonly y: number };
        readonly scale: number;
        readonly rotation?: { readonly x: number; readonly y: number; readonly z: number };
      };
    }[];
    readonly regions?: readonly {
      readonly timestampUs: number;
      readonly value: readonly { readonly bounds: Rect }[];
    }[];
  }[];
}

async function shown(page: Page): Promise<Shown> {
  const json = await page.evaluate(() =>
    (window as unknown as { desktop: DesktopBridge }).desktop.getProject().then((result) =>
      JSON.stringify(
        result.ok && result.value !== null
          ? {
              cursor: result.value.cursor,
              effects: result.value.tracks.flatMap((track) =>
                track.clips.flatMap((clip) => clip.effects),
              ),
            }
          : null,
      ),
    ),
  );
  return JSON.parse(json) as Shown;
}

async function box(locator: Locator): Promise<Rect> {
  const found = await locator.boundingBox();
  if (found === null) {
    throw new Error('The element is not visible.');
  }
  return found;
}

/**
 * The largest step between neighbouring pixels of the preview along a row,
 * in the blue channel, positions normalized to the picture: the synthetic
 * checkerboard's edges are steps of about 50; a blur smooths them out.
 */
async function sharpness(page: Page, y: number, from: number, to: number): Promise<number> {
  return page.getByTestId('preview-canvas').evaluate(
    (canvas: HTMLCanvasElement, row) => {
      const context = canvas.getContext('2d');
      if (context === null) {
        return -1;
      }
      const left = Math.round(row.from * canvas.width);
      const width = Math.round(row.to * canvas.width) - left;
      const pixels = context.getImageData(left, Math.round(row.y * canvas.height), width, 1).data;
      let largest = 0;
      for (let index = 4; index < pixels.length; index += 4) {
        largest = Math.max(largest, Math.abs((pixels[index + 2] ?? 0) - (pixels[index - 2] ?? 0)));
      }
      return largest;
    },
    { y, from, to },
  );
}

/** Drags with the mouse from one point to another in small steps. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

test('adds, shapes and keyframes effects, sets the cursor, and saves them', async () => {
  test.setTimeout(120_000);
  const launched = await launchDesktopApp();
  try {
    const page = await launched.app.firstWindow();
    const bundle = await recordSynthetic(page, { seconds: 4, withTone: false });
    await page.getByRole('heading', { level: 2 }).click();
    const bars = page.getByTestId('effect-bar');
    const inspector = page.getByTestId('effect-inspector');

    // A zoom at 1 s, toward the synthetic pointer; then aimed by a click on the picture.
    await page.keyboard.press('Shift+ArrowRight');
    await page.getByRole('button', { name: 'Add zoom' }).click();
    await expect(bars).toHaveCount(1);
    await expect(inspector.getByRole('heading', { name: 'Zoom' })).toBeVisible();
    await expect.poll(async () => (await shown(page)).effects[0]?.range.startUs).toBe(1_000_000);

    const stage = await box(page.getByTestId('preview-stage'));
    await page.mouse.click(stage.x + stage.width * 0.25, stage.y + stage.height * 0.75);
    await expect
      .poll(async () => (await shown(page)).effects[0]?.poses?.[0]?.value.anchor.x ?? 0)
      .toBeCloseTo(0.25, 1);
    expect((await shown(page)).effects[0]?.poses?.[0]?.value.anchor.y).toBeCloseTo(0.75, 1);

    // Five steps up the scale slider, each committed as the key comes up.
    const scale = inspector.getByLabel('Scale');
    await scale.focus();
    for (let step = 0; step < 5; step += 1) {
      await page.keyboard.press('ArrowRight');
    }
    await expect
      .poll(async () => (await shown(page)).effects[0]?.poses?.[0]?.value.scale)
      .toBeCloseTo(2.5, 5);

    // Three steps of tilt turn the picture in 3D, its top edge away.
    await inspector.getByLabel('Tilt').focus();
    for (let step = 0; step < 3; step += 1) {
      await page.keyboard.press('ArrowRight');
    }
    await expect
      .poll(async () => (await shown(page)).effects[0]?.poses?.[0]?.value.rotation)
      .toEqual({ x: 3, y: 0, z: 0 });

    // A blur, moved on the picture, then given a second keyframe a second later.
    await page.getByRole('heading', { level: 2 }).click();
    await page.keyboard.press('b');
    await expect(bars).toHaveCount(2);
    await expect(inspector.getByRole('heading', { name: 'Blur' })).toBeVisible();
    const blurBox = await box(page.getByTestId('blur-box'));
    const centre = { x: blurBox.x + blurBox.width / 2, y: blurBox.y + blurBox.height / 2 };
    await drag(page, centre, { x: centre.x + stage.width * 0.2, y: centre.y });
    const blurOf = async () => (await shown(page)).effects.find((effect) => effect.kind === 'blur');
    await expect
      .poll(async () => (await blurOf())?.regions?.[0]?.value[0]?.bounds.x ?? 0)
      .toBeCloseTo(0.55, 1);
    // The preview shows it there at once: smooth inside the box, sharp edges outside.
    await expect.poll(() => sharpness(page, 0.5, 0.6, 0.8)).toBeLessThan(15);
    expect(await sharpness(page, 0.9, 0.1, 0.5)).toBeGreaterThan(30);

    await page.getByRole('heading', { level: 2 }).click();
    await page.keyboard.press('Shift+ArrowRight');
    await inspector.getByRole('button', { name: 'Add keyframe' }).click();
    await expect(inspector.getByTestId('effect-keyframes')).toHaveText('2 keyframes');
    const moved = await box(page.getByTestId('blur-box'));
    await drag(
      page,
      { x: moved.x + moved.width / 2, y: moved.y + moved.height / 2 },
      { x: moved.x + moved.width / 2, y: moved.y + moved.height / 2 - stage.height * 0.2 },
    );
    await expect
      .poll(async () => (await blurOf())?.regions?.[1]?.value[0]?.bounds.y ?? 1)
      .toBeCloseTo(0.15, 1);
    expect((await blurOf())?.regions?.map((keyframe) => keyframe.timestampUs)).toEqual([
      1_000_000, 2_000_000,
    ]);

    // The cursor setting, undone and redone.
    await page.getByRole('tab', { name: 'Cursor' }).click();
    const showCursor = page.getByLabel('Show the cursor');
    await showCursor.uncheck();
    await expect.poll(async () => (await shown(page)).cursor.visible).toBe(false);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(showCursor).toBeChecked();
    await page.getByRole('button', { name: 'Redo' }).click();
    await expect(showCursor).not.toBeChecked();
    // Clicks can show in several ways.
    await page.getByRole('radio', { name: 'Bounce', exact: true }).click();
    await expect.poll(async () => (await shown(page)).cursor.clickEffect).toBe('bounce');

    // Delete removes the selected effect.
    await bars.nth(1).click();
    await expect(inspector.getByRole('heading', { name: 'Blur' })).toBeVisible();
    await page.keyboard.press('Delete');
    await expect(bars).toHaveCount(1);

    // Dragging the zoom's end on the timeline lengthens it.
    const zoomBar = await box(bars.first());
    await drag(
      page,
      { x: zoomBar.x + zoomBar.width - 2, y: zoomBar.y + zoomBar.height / 2 },
      { x: zoomBar.x + zoomBar.width + 40, y: zoomBar.y + zoomBar.height / 2 },
    );
    await expect
      .poll(async () => (await shown(page)).effects[0]?.range.durationUs ?? 0)
      .toBeGreaterThan(3_000_000);
    // One drag, one edit: a single undo takes it back, and redo returns it.
    const lengthened = (await shown(page)).effects[0]?.range.durationUs;
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await shown(page)).effects[0]?.range.durationUs).toBe(3_000_000);
    await page.getByRole('button', { name: 'Redo' }).click();
    await expect
      .poll(async () => (await shown(page)).effects[0]?.range.durationUs)
      .toBe(lengthened);

    // A second keyframe on the zoom, aimed elsewhere: the camera pans from one to the other.
    await inspector.getByRole('button', { name: 'Add keyframe' }).click();
    await expect(inspector.getByTestId('effect-keyframes')).toHaveText('2 keyframes');
    await page.mouse.click(stage.x + stage.width * 0.75, stage.y + stage.height * 0.25);
    await expect
      .poll(async () => (await shown(page)).effects[0]?.poses?.[1]?.value.anchor.x ?? 0)
      .toBeCloseTo(0.75, 1);
    const [firstPose, secondPose] = (await shown(page)).effects[0]?.poses ?? [];
    expect(firstPose?.value.anchor.x).toBeCloseTo(0.25, 1);
    expect(secondPose?.value.anchor.y).toBeCloseTo(0.25, 1);

    // All of it is in the saved manifest.
    await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 10_000 });
    const manifest = decodeManifest(await readFile(path.join(bundle, 'manifest.json'), 'utf8'));
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    const { project } = manifest.value;
    expect(project.settings.cursor).toMatchObject({ visible: false, clickEffect: 'bounce' });
    const saved = project.timeline.tracks.flatMap((track) =>
      track.clips.flatMap((clip) => clip.effects),
    );
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      kind: 'zoom',
      poses: [
        { value: { scale: 2.5, rotation: { x: 3, y: 0, z: 0 } } },
        { value: { scale: 2.5, rotation: { x: 3, y: 0, z: 0 } } },
      ],
    });
  } finally {
    await launched.close();
  }
});
