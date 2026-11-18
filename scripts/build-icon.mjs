// @ts-check
/**
 * Draws usee's app icon at every size Windows asks for and packs them into
 * apps/desktop/build-resources/icon.ico; the large drawing is also the
 * README's mark, docs/images/usee-mark.svg. The design lives here, in code:
 * the sidebar's mark (a lens ring around the amber tally light) on a
 * squircle plate, redrawn for each size so the small ones keep to the pixel
 * grid instead of being shrunk from the large one.
 *
 *   npx electron scripts/build-icon.mjs [--preview <png>]
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow } from 'electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

const PAPER = '#eef1fb';
const TALLY = '#ffb23e';
const RULE_STRONG = '#3d4670';

/**
 * @typedef {object} Geometry
 * @property {number} margin Space around the plate.
 * @property {number} ring Radius of the ring's centre line.
 * @property {number} stroke The ring's width.
 * @property {number} dot The tally light's radius.
 * @property {boolean} detail Gradients, glow and the plate's light edge.
 */

/**
 * Hand-placed below 64 px, where the ring grows a little relative to the
 * plate so it still reads; proportional from 64 up.
 * @param {number} size
 * @returns {Geometry}
 */
function geometry(size) {
  /** @type {Record<number, Omit<Geometry, 'detail'>>} */
  const small = {
    16: { margin: 0, ring: 4, stroke: 2, dot: 2 },
    20: { margin: 0, ring: 5, stroke: 2.5, dot: 2.5 },
    24: { margin: 0.5, ring: 6, stroke: 2.5, dot: 3 },
    32: { margin: 1, ring: 8, stroke: 3, dot: 4 },
    40: { margin: 1, ring: 10, stroke: 3.5, dot: 4.5 },
    48: { margin: 1.5, ring: 11.75, stroke: 4, dot: 5.25 },
  };
  const placed = small[size];
  if (placed !== undefined) {
    return { ...placed, detail: size >= 40 };
  }
  return {
    margin: size / 32,
    ring: size * 0.224,
    stroke: size * 0.076,
    dot: size * 0.088,
    detail: true,
  };
}

/**
 * A superellipse: corners that curve continuously into the sides.
 * @param {number} origin
 * @param {number} extent
 */
function squircle(origin, extent) {
  const half = extent / 2;
  const centre = origin + half;
  const points = [];
  for (let step = 0; step < 144; step += 1) {
    const angle = (step / 144) * 2 * Math.PI;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const x = centre + half * Math.sign(cos) * Math.abs(cos) ** (2 / 4.6);
    const y = centre + half * Math.sign(sin) * Math.abs(sin) ** (2 / 4.6);
    points.push(`${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  return `M${points.join('L')}Z`;
}

/** @param {number} size */
export function iconSvg(size) {
  const { margin, ring, stroke, dot, detail } = geometry(size);
  const c = size / 2;
  const plate = squircle(margin, size - 2 * margin);
  const glass = ring - stroke / 2;
  const large = size >= 64;
  const shadow = size / 96;

  // The glass catches the light on its upper left: a short arc, barely there.
  const reflection = (() => {
    const radius = glass * 0.7;
    const from = (205 * Math.PI) / 180;
    const to = (250 * Math.PI) / 180;
    const point = (/** @type {number} */ angle) =>
      `${(c + radius * Math.cos(angle)).toFixed(2)} ${(c + radius * Math.sin(angle)).toFixed(2)}`;
    return `M${point(from)}A${radius.toFixed(2)} ${radius.toFixed(2)} 0 0 1 ${point(to)}`;
  })();

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    '<defs>',
    `<path id="plate-shape" d="${plate}"/>`,
    '<clipPath id="plate-clip"><use href="#plate-shape"/></clipPath>',
    '<linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">',
    '<stop offset="0" stop-color="#2a3358"/><stop offset="1" stop-color="#141831"/>',
    '</linearGradient>',
    '<linearGradient id="edge" x1="0" y1="0" x2="0" y2="1">',
    '<stop offset="0" stop-color="#ffffff" stop-opacity="0.24"/>',
    '<stop offset="0.45" stop-color="#ffffff" stop-opacity="0.05"/>',
    '<stop offset="1" stop-color="#ffffff" stop-opacity="0"/>',
    '</linearGradient>',
    '<linearGradient id="ring" x1="0" y1="0" x2="0" y2="1">',
    `<stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#d5dbef"/>`,
    '</linearGradient>',
    '<radialGradient id="tally" cx="0.38" cy="0.34" r="0.75">',
    `<stop offset="0" stop-color="#ffd791"/><stop offset="0.55" stop-color="${TALLY}"/>`,
    '<stop offset="1" stop-color="#ec9214"/>',
    '</radialGradient>',
    // The light is on: a warm halo from the light's edge (0.42 of the halo) out across the glass.
    '<radialGradient id="glow">',
    `<stop offset="0.4" stop-color="${TALLY}" stop-opacity="0.42"/>`,
    `<stop offset="0.68" stop-color="${TALLY}" stop-opacity="0.1"/>`,
    `<stop offset="1" stop-color="${TALLY}" stop-opacity="0"/>`,
    '</radialGradient>',
    `<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${shadow.toFixed(2)}"/></filter>`,
    '</defs>',
    large
      ? `<use href="#plate-shape" fill="#05060d" opacity="0.5" transform="translate(0 ${shadow.toFixed(2)})" filter="url(#shadow)"/>`
      : '',
    '<use href="#plate-shape" fill="url(#plate)"/>',
    // The plate's edge, inside it: lit from above on large icons, a plain rule on small ones.
    detail
      ? `<use href="#plate-shape" fill="none" stroke="url(#edge)" stroke-width="${Math.max(2, size / 64).toFixed(2)}" clip-path="url(#plate-clip)"/>`
      : `<use href="#plate-shape" fill="none" stroke="${RULE_STRONG}" stroke-width="2" clip-path="url(#plate-clip)"/>`,
    `<circle cx="${c}" cy="${c}" r="${glass}" fill="#0c1022"/>`,
    large
      ? `<path d="${reflection}" fill="none" stroke="#ffffff" stroke-opacity="0.16" stroke-width="${(size / 80).toFixed(2)}" stroke-linecap="round"/>`
      : '',
    `<circle cx="${c}" cy="${c}" r="${ring}" fill="none" stroke="${detail ? 'url(#ring)' : PAPER}" stroke-width="${stroke}"/>`,
    detail ? `<circle cx="${c}" cy="${c}" r="${(dot * 2.4).toFixed(2)}" fill="url(#glow)"/>` : '',
    `<circle cx="${c}" cy="${c}" r="${dot}" fill="${detail ? 'url(#tally)' : TALLY}"/>`,
    '</svg>',
  ].join('');
}

/**
 * An .ico of PNG images, which Windows reads at every size since Vista.
 * @param {readonly { size: number, png: Buffer }[]} images
 */
function packIco(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, index) => {
    const entry = 6 + 16 * index;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(({ png }) => png)]);
}

/** @param {string} dataUrl */
function pngFrom(dataUrl) {
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

async function main() {
  await app.whenReady();
  const window = new BrowserWindow({ show: false });
  await window.loadURL('data:text/html,<!doctype html><meta charset="utf-8">');
  const rasterize = async (/** @type {number} */ size) =>
    pngFrom(
      /** @type {string} */ (
        await window.webContents.executeJavaScript(`(async () => {
          const image = new Image();
          image.src = 'data:image/svg+xml;base64,${Buffer.from(iconSvg(size)).toString('base64')}';
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = ${size};
          canvas.height = ${size};
          canvas.getContext('2d').drawImage(image, 0, 0, ${size}, ${size});
          return canvas.toDataURL('image/png');
        })()`)
      ),
    );

  const images = [];
  for (const size of SIZES) {
    images.push({ size, png: await rasterize(size) });
  }
  const resources = path.join(root, 'apps', 'desktop', 'build-resources');
  await writeFile(path.join(resources, 'icon.ico'), packIco(images));
  await writeFile(path.join(root, 'docs', 'images', 'usee-mark.svg'), `${iconSvg(256)}\n`);

  const previewIndex = process.argv.indexOf('--preview');
  const previewPath = previewIndex === -1 ? undefined : process.argv[previewIndex + 1];
  if (previewPath !== undefined) {
    // Every size on a dark and a light taskbar, and the small ones four times over.
    const sources = images.map(({ size, png }) => ({
      size,
      url: `data:image/png;base64,${png.toString('base64')}`,
    }));
    const sheet = /** @type {string} */ (
      await window.webContents.executeJavaScript(`(async () => {
        const sources = ${JSON.stringify(sources)};
        const canvas = document.createElement('canvas');
        canvas.width = 1180;
        canvas.height = 700;
        const context = canvas.getContext('2d');
        const rows = [['#202020', 0], ['#f3f3f3', 300]];
        for (const [colour, top] of rows) {
          context.fillStyle = colour;
          context.fillRect(0, top, canvas.width, 300);
          let x = 16;
          for (const { size, url } of sources) {
            const image = new Image();
            image.src = url;
            await image.decode();
            context.drawImage(image, x, top + 20);
            x += size + 16;
          }
          context.imageSmoothingEnabled = false;
          x = 16;
          for (const { size, url } of sources.filter((source) => source.size <= 32)) {
            const image = new Image();
            image.src = url;
            await image.decode();
            context.drawImage(image, x, top + 150, size * 4, size * 4);
            x += size * 4 + 24;
          }
        }
        return canvas.toDataURL('image/png');
      })()`)
    );
    await writeFile(previewPath, pngFrom(sheet));
  }
  app.quit();
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  app.exit(1);
});
