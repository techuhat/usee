// @ts-check
/**
 * Builds the FFmpeg runtime export uses (docs/decisions/ADR-008) from the
 * pinned sources in scripts/ffmpeg-build-config.mjs: MSVC inside a Visual
 * Studio developer environment compiles, MSYS2 runs FFmpeg's configure and
 * make. Nothing is downloaded; each archive must match its pinned SHA-256.
 *
 *   node scripts/build-ffmpeg.mjs --sources <dir> --msys2 <msys64> [--out <dir>]
 *       [--jobs <n>] [--review-reference <id> --reviewed-at <ISO time>]
 *
 * <dir> holds ffmpeg-9.0.2.tar.xz; <msys64> is an MSYS2 installation with
 * make, nasm and xz. <out> (build/ffmpeg by default) gets
 * the build tree in work/ and, in resources/ffmpeg/, what the app ships in
 * its own resources/ffmpeg: ffmpeg.exe, its licenses and build.json, the
 * provenance, with development-manifest.json, which only an unpackaged build
 * reads. runtime-manifest.json is written only when a legal review is named;
 * its SHA-256 is the trust anchor a release sets in ffmpeg-runtime-trust.ts.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  CONFIGURE_FLAGS,
  DEVELOPMENT_MANIFEST_FILE,
  developmentManifest,
  FFMPEG_SOURCE,
  HARDENING_FLAGS,
  RUNTIME_MANIFEST_FILE,
  runtimeManifest,
} from './ffmpeg-build-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} message */
function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (process.platform !== 'win32') {
  fail('The FFmpeg runtime builds on Windows only.');
}

const { values: options } = parseArgs({
  options: {
    sources: { type: 'string' },
    msys2: { type: 'string' },
    out: { type: 'string', default: path.join(root, 'build', 'ffmpeg') },
    jobs: { type: 'string', default: String(availableParallelism()) },
    'review-reference': { type: 'string' },
    'reviewed-at': { type: 'string' },
  },
});
if (options.sources === undefined || options.msys2 === undefined) {
  fail('Usage: node scripts/build-ffmpeg.mjs --sources <dir> --msys2 <msys64> [--out <dir>]');
}
const sources = path.resolve(options.sources);
const bash = path.join(path.resolve(options.msys2), 'usr', 'bin', 'bash.exe');
const out = path.resolve(options.out);
const jobs = Number.parseInt(options.jobs, 10);
const review =
  options['review-reference'] === undefined && options['reviewed-at'] === undefined
    ? undefined
    : { reference: options['review-reference'] ?? '', reviewedAt: options['reviewed-at'] ?? '' };
if (
  review !== undefined &&
  (review.reference === '' || Number.isNaN(Date.parse(review.reviewedAt)))
) {
  fail('A legal review needs both --review-reference and an ISO --reviewed-at.');
}
if (!Number.isSafeInteger(jobs) || jobs < 1) {
  fail('--jobs must be a positive whole number.');
}
for (const tool of ['bash.exe', 'make.exe', 'nasm.exe', 'xz.exe', 'tar.exe']) {
  if (!existsSync(path.join(path.dirname(bash), tool))) {
    fail(`MSYS2 at ${options.msys2} has no ${tool}: install make, nasm, xz and tar there.`);
  }
}

/** @param {string} filePath */
async function sha256Of(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

// Only the reviewed source builds: a changed archive is refused, never used.
for (const source of [FFMPEG_SOURCE]) {
  const archive = path.join(sources, source.archive);
  if (!existsSync(archive)) {
    fail(`${source.archive} is not in ${sources}.`);
  }
  const actual = await sha256Of(archive);
  if (actual !== source.sha256) {
    fail(`${source.archive} has SHA-256 ${actual}, not the pinned ${source.sha256}.`);
  }
}

// The same Visual Studio discovery as scripts/build-native.mjs.
const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
const vswhere = path.join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
if (!existsSync(vswhere)) {
  fail('Visual Studio Build Tools with the C++ workload are required.');
}
const installation = execFileSync(
  vswhere,
  [
    '-latest',
    '-products',
    '*',
    '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property',
    'installationPath',
  ],
  { encoding: 'utf8' },
).trim();
if (installation === '') {
  fail('No Visual Studio installation with the x64 C++ tools was found.');
}
const vcvars = path.join(installation, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');

const work = path.join(out, 'work');
const runtime = path.join(out, 'resources', 'ffmpeg');
await rm(out, { recursive: true, force: true });
await mkdir(work, { recursive: true });
await mkdir(runtime, { recursive: true });
const ffmpeg = path.join(work, FFMPEG_SOURCE.directory);

/** @param {readonly string[]} lines */
const shell = (lines) => `set -eu\n${lines.join('\n')}\n`;
const quote = (/** @type {string} */ value) => `'${value.replaceAll("'", "'\\''")}'`;
await writeFile(
  path.join(work, 'extract.sh'),
  shell(['tar -xJf "$(cygpath -u "$USEE_FFMPEG_ARCHIVE")"']),
);
await writeFile(
  path.join(work, 'ffmpeg.sh'),
  shell([
    `cd ${quote(FFMPEG_SOURCE.directory)}`,
    `./configure ${[...CONFIGURE_FLAGS, ...HARDENING_FLAGS].map(quote).join(' ')} > ../configure.log 2>&1 || { tail -n 40 ../configure.log; exit 1; }`,
    `make -j${jobs} > ../make.log 2>&1 || { tail -n 60 ../make.log; exit 1; }`,
  ]),
);
await writeFile(
  path.join(work, 'build.cmd'),
  [
    '@echo off',
    `call "${vcvars}" >nul || exit /b 1`,
    'set "MSYS2_PATH_TYPE=inherit"',
    'set "MSYSTEM=MSYS"',
    'set "CHERE_INVOKING=enabled"',
    `"${bash}" --login -c "bash ./extract.sh" || exit /b 1`,
    `"${bash}" --login -c "bash ./ffmpeg.sh" || exit /b 1`,
    '',
  ].join('\r\n'),
);

process.stdout.write(`Building FFmpeg ${FFMPEG_SOURCE.version} in ${work}\n`);
// vcvars64.bat runs vswhere.exe from its own directory, which
// NoDefaultCurrentDirectoryInExePath (set by some sandboxed shells) forbids.
const { NoDefaultCurrentDirectoryInExePath: _ignored, ...inherited } = process.env;
const build = spawnSync('cmd.exe', ['/d', '/c', 'build.cmd'], {
  cwd: work,
  stdio: 'inherit',
  env: {
    ...inherited,
    'ProgramFiles(x86)': programFilesX86,
    ProgramFiles: process.env['ProgramFiles'] ?? 'C:\\Program Files',
    USEE_FFMPEG_ARCHIVE: path.join(sources, FFMPEG_SOURCE.archive),
  },
});
if (build.status !== 0) {
  fail(`The FFmpeg build failed; see ${path.join(work, 'configure.log')} and make.log.`);
}

const binary = path.join(runtime, 'ffmpeg.exe');
await copyFile(path.join(ffmpeg, 'ffmpeg.exe'), binary);
await copyFile(path.join(ffmpeg, 'COPYING.LGPLv2.1'), path.join(runtime, 'LICENSE-ffmpeg.txt'));

// The binary must say what it is: LGPL, and built with exactly these flags.
const version = execFileSync(binary, ['-hide_banner', '-version'], { encoding: 'utf8' });
const license = execFileSync(binary, ['-hide_banner', '-L'], { encoding: 'utf8' });
if (!/Lesser General Public\s+License/.test(license) || !/version 2\.1/.test(license)) {
  fail('The built FFmpeg does not report the LGPL version 2.1 or later.');
}
const flags = [...CONFIGURE_FLAGS, ...HARDENING_FLAGS];
const configuration = /configuration: (.*)/.exec(version)?.[1]?.replaceAll("'", '') ?? '';
if (flags.some((flag) => !configuration.includes(flag))) {
  fail('The built FFmpeg reports a configuration other than the pinned one.');
}

const sha256 = await sha256Of(binary);
const builtAt = new Date().toISOString();
await writeFile(
  path.join(runtime, 'build.json'),
  `${JSON.stringify(
    {
      ffmpeg: {
        version: FFMPEG_SOURCE.version,
        url: FFMPEG_SOURCE.url,
        revision: FFMPEG_SOURCE.revision,
        archiveSha256: FFMPEG_SOURCE.sha256,
      },
      configureFlags: flags,
      builtWith: /built with (.*)/.exec(version)?.[1] ?? 'unknown',
      binarySha256: sha256,
      builtAt,
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(`ffmpeg.exe SHA-256 ${sha256}\n`);
/** @param {unknown} manifest */
const json = (manifest) => `${JSON.stringify(manifest, null, 2)}\n`;
await writeFile(
  path.join(runtime, DEVELOPMENT_MANIFEST_FILE),
  json(developmentManifest({ sha256, builtAt })),
);

if (review === undefined) {
  process.stdout.write(
    `No legal review named, so no ${RUNTIME_MANIFEST_FILE}: only unpackaged builds can export with this one.\n`,
  );
} else {
  const manifest = json(runtimeManifest({ sha256, builtAt, review }));
  await writeFile(path.join(runtime, RUNTIME_MANIFEST_FILE), manifest);
  const anchor = createHash('sha256').update(manifest).digest('hex');
  process.stdout.write(`${RUNTIME_MANIFEST_FILE} SHA-256 ${anchor} (the release trust anchor)\n`);
}
