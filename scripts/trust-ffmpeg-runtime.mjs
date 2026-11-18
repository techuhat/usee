// @ts-check
/**
 * For a release build (.github/workflows/release.yml): sets the SHA-256 of the
 * runtime manifest that `npm run build:ffmpeg` has just written, under a named
 * legal review, as the trust anchor in
 * apps/desktop/src/main/ffmpeg-runtime-trust.ts. The packaged app then runs that
 * runtime and no other (docs/security.md), and `npm run package` ships it.
 *
 *   node scripts/trust-ffmpeg-runtime.mjs [--runtime <dir>]
 *
 * <dir> is the runtime's folder, build/ffmpeg/resources/ffmpeg by default.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { RUNTIME_MANIFEST_FILE } from './ffmpeg-build-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: options } = parseArgs({
  options: {
    runtime: { type: 'string', default: path.join(root, 'build', 'ffmpeg', 'resources', 'ffmpeg') },
  },
});

const manifest = await readFile(path.join(options.runtime, RUNTIME_MANIFEST_FILE));
const anchor = createHash('sha256').update(manifest).digest('hex');
const trustFile = path.join(root, 'apps', 'desktop', 'src', 'main', 'ffmpeg-runtime-trust.ts');
const source = await readFile(trustFile, 'utf8');
const pattern = /TRUSTED_FFMPEG_MANIFEST_SHA256 = '[0-9a-f]*'/;
if (!pattern.test(source)) {
  process.stderr.write(`${trustFile} no longer declares TRUSTED_FFMPEG_MANIFEST_SHA256.\n`);
  process.exit(1);
}
await writeFile(trustFile, source.replace(pattern, `TRUSTED_FFMPEG_MANIFEST_SHA256 = '${anchor}'`));
process.stdout.write(`The app now trusts ${RUNTIME_MANIFEST_FILE} ${anchor}.\n`);
