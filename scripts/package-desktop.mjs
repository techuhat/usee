// @ts-check
/**
 * Packages the desktop app as a per-user Windows installer (docs/release.md,
 * "Packaging"). electron-builder packs a staged app that holds only the
 * bundled main, preload and renderer (esbuild and Vite bundle every
 * dependency, so no node_modules ship), with the recorder host in its
 * resources and, only when a legal review has accepted it and the app trusts
 * its manifest, the FFmpeg runtime (docs/decisions/ADR-008).
 *
 *   npm run package
 *   npm run package:store
 *
 * It needs `npm run build` (run by both scripts) and the recorder host from
 * `node scripts/build-native.mjs`. It writes build/release/usee-<version>-
 * setup.exe and build/release/win-unpacked/. The installer is signed only
 * when signing credentials are configured; nothing here supplies them.
 * With --store it writes build/release/usee-<version>-store.appx instead, the
 * package for the Microsoft Store, which signs it (docs/release.md,
 * "Microsoft Store").
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Arch, build, Platform } from 'electron-builder';

import { RUNTIME_MANIFEST_FILE } from './ffmpeg-build-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.join(root, 'apps', 'desktop');
const host = path.join(root, 'native', 'recorder-host', 'build', 'release');
const ffmpeg = path.join(root, 'build', 'ffmpeg', 'resources', 'ffmpeg');
const staging = path.join(root, 'build', 'package', 'app');
const notices = path.join(root, 'build', 'package', 'notices');
const output = path.join(root, 'build', 'release');
const forStore = process.argv.includes('--store');

// The Microsoft Store product, as Partner Center's Product identity page
// names it. The display name must be one of the names reserved for it.
const store = {
  identityName: 'techuhat.Usee3DMotion-ScreenRecoder',
  publisher: 'CN=20FA8C00-8CAA-408F-9AC1-DA779DD34040',
  publisherDisplayName: 'techuhat',
  displayName: 'Usee 3D Motion - Screen Recoder',
  description: 'A free, open-source screen recorder and editor for Windows.',
};

/** @param {string} message */
function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (process.platform !== 'win32') {
  fail('The installer builds on Windows only.');
}

/** @type {{ productName: string, version: string, description: string, main: string, devDependencies: Record<string, string> }} */
const desktopPackage = JSON.parse(await readFile(path.join(desktop, 'package.json'), 'utf8'));
for (const built of [
  desktopPackage.main,
  path.join('dist', 'preload', 'preload.cjs'),
  path.join('dist', 'renderer', 'index.html'),
]) {
  if (!existsSync(path.join(desktop, built))) {
    fail(`apps/desktop/${built} is missing: run npm run build first.`);
  }
}
if (!existsSync(path.join(host, 'recorder-host.exe'))) {
  fail('The recorder host is missing: run node scripts/build-native.mjs first.');
}

// FFmpeg ships only as a reviewed runtime the app already trusts: its
// manifest's SHA-256 must be the anchor in ffmpeg-runtime-trust.ts.
const trust = await readFile(path.join(desktop, 'src', 'main', 'ffmpeg-runtime-trust.ts'), 'utf8');
const anchor = /TRUSTED_FFMPEG_MANIFEST_SHA256 = '([0-9a-f]*)'/.exec(trust)?.[1] ?? '';
const manifest = path.join(ffmpeg, RUNTIME_MANIFEST_FILE);
let shipsFfmpeg = false;
if (anchor !== '') {
  if (!existsSync(manifest)) {
    fail(`The app trusts an FFmpeg manifest, but ${RUNTIME_MANIFEST_FILE} is not in ${ffmpeg}.`);
  }
  const digest = createHash('sha256')
    .update(await readFile(manifest))
    .digest('hex');
  if (digest !== anchor) {
    fail(`${RUNTIME_MANIFEST_FILE} has SHA-256 ${digest}, not the trusted ${anchor}.`);
  }
  shipsFfmpeg = true;
}

// The app as it runs: the bundles and a package.json naming the main bundle.
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await cp(path.join(desktop, 'dist'), path.join(staging, 'dist'), {
  recursive: true,
  filter: (source) => !source.endsWith('.map'),
});
await writeFile(
  path.join(staging, 'package.json'),
  `${JSON.stringify(
    {
      name: 'usee',
      productName: desktopPackage.productName,
      version: desktopPackage.version,
      // Windows shows the Store package's description to its users.
      description: forStore ? store.description : desktopPackage.description,
      author: 'usee',
      main: desktopPackage.main,
      private: true,
    },
    null,
    2,
  )}\n`,
);

// The licences that travel beside usee.exe: usee's own, and those of the
// packages bundled into it, which are the lockfile's runtime dependencies.
// Electron adds its own and Chromium's; FFmpeg's ships with its runtime.
/** @type {{ packages: Record<string, { version?: string, license?: string, dev?: boolean, devOptional?: boolean, link?: boolean }> }} */
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const bundled = [];
for (const [key, entry] of Object.entries(lock.packages)) {
  if (!key.startsWith('node_modules/') || entry.dev || entry.devOptional || entry.link) {
    continue;
  }
  const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const directory = path.join(root, key);
  const licence = (await readdir(directory)).find((file) => /^licen[cs]e(\.|$)/i.test(file));
  if (licence === undefined) {
    fail(`${name} is bundled into the app but has no licence file to ship with it.`);
  } else {
    const text = (await readFile(path.join(directory, licence), 'utf8')).trim();
    bundled.push(`${name} ${entry.version ?? ''} (${entry.license ?? 'see below'})\n\n${text}\n`);
  }
}
await rm(notices, { recursive: true, force: true });
await mkdir(notices, { recursive: true });
await cp(path.join(root, 'LICENSE'), path.join(notices, 'LICENSE.txt'));
await cp(path.join(root, 'PRIVACY.md'), path.join(notices, 'PRIVACY.txt'));
await writeFile(
  path.join(notices, 'THIRD-PARTY-NOTICES.txt'),
  [
    'usee includes the software below, each under the licence that follows it.',
    "Electron's and Chromium's licences are in LICENSE.electron.txt and LICENSES.chromium.html,",
    "and FFmpeg's, when the app ships it, in resources/ffmpeg/LICENSE-ffmpeg.txt.",
    '',
    ...bundled,
  ].join('\n'),
);

const electronVersion = desktopPackage.devDependencies['electron'];
if (electronVersion === undefined) {
  fail('apps/desktop/package.json does not pin Electron.');
}

await build({
  projectDir: staging,
  targets: Platform.WINDOWS.createTarget(forStore ? 'appx' : 'nsis', Arch.x64),
  publish: 'never',
  config: {
    appId: 'app.usee.desktop',
    productName: desktopPackage.productName,
    electronVersion,
    // The Store package's images are in build-resources/appx.
    directories: forStore
      ? { output, buildResources: path.join(desktop, 'build-resources') }
      : { output },
    // The Windows SDK 10.0.26100 tools: the default bundle's makepri.exe
    // fails on Windows 11 (PRI191, 0x8007007e) when it indexes the images.
    ...(forStore ? { toolsets: { winCodeSign: '1.1.0' } } : {}),
    files: ['dist/**/*', 'package.json'],
    asar: true,
    npmRebuild: false,
    nodeGypRebuild: false,
    extraFiles: [
      { from: notices, to: '.', filter: ['LICENSE.txt', 'PRIVACY.txt', 'THIRD-PARTY-NOTICES.txt'] },
    ],
    extraResources: [
      {
        from: host,
        to: 'recorder-host',
        filter: ['recorder-host.exe', 'recorder-host.exe.manifest'],
      },
      ...(shipsFfmpeg
        ? [
            {
              from: ffmpeg,
              to: 'ffmpeg',
              filter: ['ffmpeg.exe', RUNTIME_MANIFEST_FILE, 'LICENSE-ffmpeg.txt', 'build.json'],
            },
          ]
        : []),
    ],
    // Drawn for every size Windows shows, by scripts/build-icon.mjs.
    win: { icon: path.join(desktop, 'build-resources', 'icon.ico') },
    nsis: {
      installerIcon: path.join(desktop, 'build-resources', 'icon.ico'),
      uninstallerIcon: path.join(desktop, 'build-resources', 'icon.ico'),
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: desktopPackage.productName,
      artifactName: '${productName}-${version}-setup.${ext}',
    },
    appx: {
      identityName: store.identityName,
      publisher: store.publisher,
      publisherDisplayName: store.publisherDisplayName,
      displayName: store.displayName,
      applicationId: 'usee',
      backgroundColor: '#141831',
      languages: ['en-US'],
      // runFullTrust, which every desktop app needs, and the microphone a
      // recording may use. Capture needs nothing more: the host records
      // through Windows.Graphics.Capture with the border Windows draws.
      capabilities: ['runFullTrust', 'microphone'],
      // Windows 10 version 2004, the oldest usee supports.
      minVersion: '10.0.19041.0',
      maxVersionTested: '10.0.26100.0',
      artifactName: '${productName}-${version}-store.${ext}',
    },
  },
});

const packaged = forStore ? 'Packaged usee for the Microsoft Store' : 'Packaged usee';
process.stdout.write(
  shipsFfmpeg
    ? `${packaged} ${desktopPackage.version} with its reviewed FFmpeg runtime in ${output}.\n`
    : `${packaged} ${desktopPackage.version} in ${output}, without FFmpeg: no legal review has accepted a runtime (docs/decisions/ADR-008), so the installed app records and edits but cannot export.\n`,
);
