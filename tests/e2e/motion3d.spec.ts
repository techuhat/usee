import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { effectSchema, type DesktopBridge, type EditProjectRequest } from '@usee/contracts';
import { decodeManifest, PROJECT_FORMAT_VERSION } from '@usee/project-format';

import { hostExecutable, launchDesktopApp } from './launch-app';
import { recordSynthetic } from './record';

test.skip(!existsSync(hostExecutable), 'The native recorder host has not been built.');

const FRAME_US = 1_000_000 / 60;

/** A light canvas, so the turned card's edges and shadow show against it in the goldens. */
const LIGHT_CANVAS = {
  aspect: 'source',
  background: { kind: 'gradient', from: '#ffb88c', to: '#de6262', angle: 135 },
  padding: 0.06,
  cornerRadius: 0.04,
  shadow: { opacity: 0.45, blur: 0.04, offsetY: 0.01 },
} as const;

/** The clip's own zoom, aimed exactly, so the goldens do not depend on where a press lands. */
const ownZoom = effectSchema.parse({
  id: 'motion-zoom',
  kind: 'zoom',
  range: { startUs: 500_000, durationUs: 3_000_000 },
  enabled: true,
  poses: [
    {
      timestampUs: 500_000,
      value: { anchor: { x: 0.4, y: 0.55 }, scale: 2 },
      easing: 'ease-in-out',
    },
  ],
  easeInUs: 500_000,
  easeOutUs: 500_000,
  easing: 'ease-in-out',
});

interface ShownZoom {
  readonly lens?: number;
  readonly poses: readonly {
    readonly hold?: boolean;
    readonly value: {
      readonly scale: number;
      readonly rotation?: { readonly x: number; readonly y: number; readonly z: number };
    };
  }[];
}

/** The generated camera's settings and the clip's own zoom, through the bridge. */
async function shown(page: Page) {
  const json = await page.evaluate(() =>
    (window as unknown as { desktop: DesktopBridge }).desktop.getProject().then((result) =>
      JSON.stringify(
        result.ok && result.value !== null
          ? {
              autoZoom: result.value.autoZoom,
              zoom: result.value.tracks
                .flatMap((track) => track.clips.flatMap((clip) => clip.effects))
                .find((effect) => effect.kind === 'zoom'),
            }
          : null,
      ),
    ),
  );
  return JSON.parse(json) as {
    autoZoom: { enabled: boolean; turn3d?: number };
    zoom: ShownZoom | undefined;
  };
}

async function edit(page: Page, command: EditProjectRequest['command']): Promise<void> {
  const applied = await page.evaluate(
    (json) =>
      (window as unknown as { desktop: DesktopBridge }).desktop
        .editProject(JSON.parse(json) as EditProjectRequest)
        .then((result) => result.ok),
    JSON.stringify({ command }),
  );
  expect(applied).toBe(true);
}

/** The frame the preview shows once it has stopped changing for a few tenths of a second. */
async function settledFrame(page: Page): Promise<number> {
  const canvas = page.getByTestId('preview-canvas');
  let last = Number.NaN;
  let steady = 0;
  for (let read = 0; read < 50 && steady < 3; read += 1) {
    const now = Number(await canvas.getAttribute('data-source-us'));
    steady = now === last ? steady + 1 : 0;
    last = now;
    await page.waitForTimeout(100);
  }
  return Math.round(last / FRAME_US);
}

/**
 * Steps the playhead by whole frames to `frame` and waits until the preview
 * shows it (docs/testing.md, "Visual goldens"). A press on the timeline seeks
 * and the preview catches up a little later, so it steps from what the
 * preview shows once settled, and corrects until it lands.
 */
async function goTo(page: Page, frame: number): Promise<void> {
  const canvas = page.getByTestId('preview-canvas');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const at = await settledFrame(page);
    if (at === frame) {
      break;
    }
    for (let step = at; step !== frame; step += Math.sign(frame - at)) {
      await page.keyboard.press(frame > at ? 'ArrowRight' : 'ArrowLeft');
    }
  }
  const expectedUs = Math.floor(frame * FRAME_US);
  await expect(canvas).toHaveAttribute('data-source-us', String(expectedUs));
  await expect
    .poll(async () => Math.abs(Number(await canvas.getAttribute('data-frame-us')) - expectedUs))
    .toBeLessThanOrEqual(1_000);
}

test('moves the camera in 3D: the generated camera turns, and a zoom takes presets, a lens and a drag', async () => {
  test.setTimeout(180_000);
  const launched = await launchDesktopApp();
  try {
    const page = await launched.app.firstWindow();
    const bundle = await recordSynthetic(page, { seconds: 4, withTone: false });
    await page.getByRole('heading', { level: 2 }).click();
    const canvas = page.getByTestId('preview-canvas');
    const golden = { maxDiffPixelRatio: 0.01 };
    await edit(page, { type: 'set-canvas', style: LIGHT_CANVAS });

    // One switch turns the generated camera toward each action.
    await page.getByRole('tab', { name: 'Camera' }).click();
    await page.getByLabel('Turn toward each action').check();
    await expect.poll(async () => (await shown(page)).autoZoom.turn3d).toBe(0.6);
    await page.getByRole('heading', { level: 2 }).click();
    await goTo(page, 78); // 1.30 s: held on the second click, leaning toward it
    await expect(canvas).toHaveScreenshot('generated-3d-second-click.png', golden);

    // The clip's own zoom, over the generated camera turned off.
    await edit(page, { type: 'set-auto-zoom', enabled: false, scale: 2 });
    const clipId = await page.evaluate(() =>
      (window as unknown as { desktop: DesktopBridge }).desktop
        .getProject()
        .then((result) =>
          result.ok && result.value !== null ? result.value.tracks[0]?.clips[0]?.id : undefined,
        ),
    );
    expect(clipId).toBeDefined();
    if (clipId === undefined) return;
    await edit(page, { type: 'add-effect', clipId, effect: ownZoom });
    const bar = page.getByTestId('effect-bar').first();
    await bar.click();

    // Dragging the turn handle turns the picture, as one undoable edit.
    const handle = page.getByTestId('turn-handle');
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    if (box === null) return;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect
      .poll(async () => (await shown(page)).zoom?.poses[0]?.value.rotation?.y ?? 0)
      .toBeGreaterThan(5);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect
      .poll(async () => (await shown(page)).zoom?.poses[0]?.value.rotation)
      .toBeUndefined();

    // A preset writes the zoom's keyframes in one step; the orbit flows through its middle one.
    const inspector = page.getByTestId('effect-inspector');
    await inspector.getByRole('button', { name: 'Orbit' }).click();
    await expect.poll(async () => (await shown(page)).zoom?.poses.length).toBe(3);
    expect((await shown(page)).zoom?.poses[1]?.hold).toBeUndefined();
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await shown(page)).zoom?.poses.length).toBe(1);
    await page.getByRole('button', { name: 'Redo' }).click();
    await expect.poll(async () => (await shown(page)).zoom?.poses.length).toBe(3);

    // A stronger lens deepens the turn.
    await inspector.getByRole('radio', { name: 'Strong', exact: true }).click();
    await expect.poll(async () => (await shown(page)).zoom?.lens).toBe(50);

    // Mid-orbit, the picture floats over the canvas as a turned card.
    await page.keyboard.press('Escape');
    await page.getByRole('heading', { level: 2 }).click();
    await goTo(page, 81); // 1.35 s: swinging from the left toward the middle
    await expect(canvas).toHaveScreenshot('orbit-mid-move.png', golden);

    // Pulled out, the whole picture shows smaller than its place, turned.
    await bar.click();
    await inspector.getByRole('button', { name: 'Pull out' }).click();
    await expect
      .poll(async () => (await shown(page)).zoom?.poses.at(-1)?.value.scale)
      .toBeLessThan(1);
    await page.keyboard.press('Escape');
    await page.getByRole('heading', { level: 2 }).click();
    await goTo(page, 171); // 2.85 s: all but there, mid-step of the pattern
    await expect(canvas).toHaveScreenshot('pull-out-over-canvas.png', golden);

    // What stands is in the saved manifest.
    await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 10_000 });
    const manifest = decodeManifest(await readFile(path.join(bundle, 'manifest.json'), 'utf8'));
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    expect(manifest.value.manifestVersion).toBe(PROJECT_FORMAT_VERSION);
    expect(manifest.value.project.settings.autoZoom.turn3d).toBe(0.6);
    const saved = manifest.value.project.timeline.tracks[0]?.clips[0]?.effects.find(
      (effect) => effect.kind === 'zoom',
    );
    expect(saved?.kind === 'zoom' && saved.lens).toBe(50);
    expect(saved?.kind === 'zoom' && saved.poses.at(-1)?.value.scale).toBe(0.8);
  } finally {
    await launched.close();
  }
});
