import { existsSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import { effectSchema, type DesktopBridge, type EditProjectRequest } from '@usee/contracts';

import { hostExecutable, launchDesktopApp } from './launch-app';
import { recordSynthetic } from './record';

test.skip(!existsSync(hostExecutable), 'The native recorder host has not been built.');

const FRAME_US = 1_000_000 / 60;

const zoomAt = (pose: object) =>
  effectSchema.parse({
    id: 'golden-zoom',
    kind: 'zoom',
    range: { startUs: 1_000_000, durationUs: 2_500_000 },
    enabled: true,
    poses: [{ timestampUs: 1_000_000, value: pose, easing: 'ease-in-out' }],
    easeInUs: 500_000,
    easeOutUs: 500_000,
    easing: 'ease-in-out',
  });

const zoom = zoomAt({ anchor: { x: 0.35, y: 0.6 }, scale: 2 });
// The same zoom with the picture turned in 3D: top edge away, left edge away, a little clockwise.
const turnedZoom = zoomAt({
  anchor: { x: 0.35, y: 0.6 },
  scale: 2,
  rotation: { x: 12, y: -10, z: 4 },
});

const blur = effectSchema.parse({
  id: 'golden-blur',
  kind: 'blur',
  range: { startUs: 250_000, durationUs: 3_500_000 },
  enabled: true,
  intensity: 0.02,
  regions: [
    {
      timestampUs: 250_000,
      value: [{ kind: 'rectangle', bounds: { x: 0.05, y: 0.05, width: 0.25, height: 0.2 } }],
      easing: 'linear',
    },
    {
      timestampUs: 2_500_000,
      value: [{ kind: 'rectangle', bounds: { x: 0.45, y: 0.55, width: 0.25, height: 0.2 } }],
      easing: 'linear',
    },
  ],
});

/** Edits the project through the bridge, as the editor's controls do, with exact numbers. */
async function edit(page: Page, command: EditProjectRequest['command']): Promise<void> {
  const request = JSON.stringify({ command });
  const applied = await page.evaluate(
    (json) =>
      (window as unknown as { desktop: DesktopBridge }).desktop
        .editProject(JSON.parse(json) as EditProjectRequest)
        .then((result) => result.ok),
    request,
  );
  expect(applied).toBe(true);
}

/**
 * Moves the playhead by whole frames with the arrow keys and waits until the
 * preview shows that frame: the synthetic pattern steps every 250 ms and the
 * synthetic pointer runs on the session clock, so each named moment shows the
 * same picture in every recording (docs/testing.md, "Visual goldens").
 */
async function stepTo(page: Page, fromFrame: number, toFrame: number): Promise<void> {
  for (let frame = fromFrame; frame !== toFrame; frame += Math.sign(toFrame - fromFrame)) {
    await page.keyboard.press(toFrame > fromFrame ? 'ArrowRight' : 'ArrowLeft');
  }
  const expectedUs = Math.floor(toFrame * FRAME_US);
  const canvas = page.getByTestId('preview-canvas');
  await expect(canvas).toHaveAttribute('data-source-us', String(expectedUs));
  await expect
    .poll(async () => Math.abs(Number(await canvas.getAttribute('data-frame-us')) - expectedUs))
    .toBeLessThanOrEqual(1_000);
}

test('draws the cursor, clicks, zoom and blur into the preview, paused and playing', async () => {
  test.setTimeout(120_000);
  const launched = await launchDesktopApp();
  try {
    const page = await launched.app.firstWindow();
    await recordSynthetic(page, { seconds: 4.5, withTone: false });
    const clipId = await page.evaluate(() =>
      (window as unknown as { desktop: DesktopBridge }).desktop
        .getProject()
        .then((result) => (result.ok ? result.value?.tracks[0]?.clips[0]?.id : undefined)),
    );
    expect(clipId).toBeDefined();
    if (clipId === undefined) return;

    // Keys go to the editor, not to a control that kept focus from recording.
    await page.getByRole('heading', { level: 2 }).click();
    const canvas = page.getByTestId('preview-canvas');
    const golden = { maxDiffPixelRatio: 0.01 };

    // The camera generated from the synthetic clicks, once a second: held on
    // the second click, then on the third (between pans, so a recording that
    // starts a little later shows the same picture).
    await expect(page.getByTestId('auto-zoom-bar')).toHaveCount(1);
    let frame = 0;
    for (const [name, target] of [
      ['auto-zoom-second-click', 78], // 1.30 s: lower left, the arrow
      ['auto-zoom-third-click', 138], // 2.30 s: upper left, the hand cursor
    ] as const) {
      await stepTo(page, frame, target);
      frame = target;
      await expect(canvas).toHaveScreenshot(`${name}.png`, golden);
    }

    // Without it, each way a click can show, a third of the way through.
    await page.getByRole('tab', { name: 'Camera' }).click();
    await page.getByLabel('Zoom in on clicks').uncheck();
    await expect(page.getByTestId('auto-zoom-bar')).toHaveCount(0);
    await page.getByRole('heading', { level: 2 }).click();
    await stepTo(page, frame, 39); // 0.65 s
    frame = 39;
    const cursor = { visible: true, size: 1.5, smoothing: 0.5 } as const;
    for (const clickEffect of ['pulse', 'ring', 'bounce'] as const) {
      await edit(page, { type: 'set-cursor', settings: { ...cursor, clickEffect } });
      await expect(canvas).toHaveScreenshot(`click-${clickEffect}.png`, golden);
    }
    await edit(page, { type: 'set-cursor', settings: { ...cursor, clickEffect: 'ripple' } });

    // Then the clip's own zoom and blur.
    await edit(page, { type: 'add-effect', clipId, effect: zoom });
    await edit(page, { type: 'add-effect', clipId, effect: blur });
    await page.getByRole('heading', { level: 2 }).click();
    const moments: readonly (readonly [string, number])[] = [
      ['cursor-and-blur', 24], // 0.40 s: the arrow, the blur at its first keyframe
      ['click-ripple', 39], // 0.65 s: a ripple a third of the way through
      ['zooming-in', 78], // 1.30 s: most of the way into the zoom
      ['zoomed-click', 99], // 1.65 s: a ripple and the moving blur under the zoom
      ['zoomed-hand-cursor', 129], // 2.15 s: the hand cursor under the zoom
    ];
    for (const [name, target] of moments) {
      await stepTo(page, frame, target);
      frame = target;
      await expect(canvas).toHaveScreenshot(`${name}.png`, golden);
    }

    // Turned in 3D, the held zoom shows the picture as a card in perspective, floating over a
    // light canvas with its rounded corners and shadow, the canvas showing past its edges.
    await edit(page, {
      type: 'set-canvas',
      style: {
        aspect: 'source',
        background: { kind: 'gradient', from: '#ffb88c', to: '#de6262', angle: 135 },
        padding: 0.06,
        cornerRadius: 0.04,
        shadow: { opacity: 0.45, blur: 0.04, offsetY: 0.01 },
      },
    });
    await edit(page, { type: 'update-effect', clipId, effect: turnedZoom });
    await stepTo(page, frame, 141); // 2.35 s: the hand cursor, between clicks
    frame = 141;
    await expect(canvas).toHaveScreenshot('zoom-turned-in-3d.png', golden);

    // Playing, the preview draws the frames as the video presents them.
    await page.keyboard.press('Space');
    const pausedAt = Number(await canvas.getAttribute('data-frame-us'));
    await expect
      .poll(async () => Number(await canvas.getAttribute('data-frame-us')))
      .toBeGreaterThan(pausedAt + 200_000);
  } finally {
    await launched.close();
  }
});
