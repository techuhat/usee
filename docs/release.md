# Build, packaging, and release architecture

## Build outputs

```text
TypeScript packages → Electron main/preload/renderer artifacts
C++ recorder host  → architecture-specific signed executable
FFmpeg manifest    → pinned executable + notices + checksum
all artifacts      → signed Windows installer / update payload
```

The foundation build validates TypeScript packages and produces the secure blank Electron app. Native recorder-host compilation begins with the recording vertical slice and runs on a Windows CI image with the approved Windows SDK and Build Tools.

## Release flow

1. CI installs pinned dependencies and runs format, lint, boundary, type, test, and production-build checks.
2. Release CI builds x64 first (ARM64 follows as a deliberate matrix expansion), compiles native artifacts, and records build provenance.
3. Security/license checks validate dependency reports, FFmpeg manifest, code-signing inputs, and artifact hashes.
4. The installer, the application and the recorder host receive Authenticode signatures; `ffmpeg.exe`, built from upstream source, ships unsigned inside the signed installer, and the app checks it against its trusted runtime manifest before running it ("Signing").
5. Smoke tests run against the packaged app; hardware/export suites approve a release candidate.
6. Update metadata is published only after signed artifacts are available. The application defers installation during active recording or render jobs.

`.github/workflows/release.yml` is that release CI so far, x64 only. A tag `v<version>` naming the version in `apps/desktop/package.json` builds the recorder host and runs its tests, downloads `ffmpeg-9.0.2.tar.xz` (the FFmpeg build refuses it unless its SHA-256 is the pinned one), builds the runtime under the review ADR-012 records, sets that runtime's manifest SHA-256 as the trust anchor (`scripts/trust-ffmpeg-runtime.mjs`), packages the installer, runs the export worker's own commands against that runtime (`tests/integration/ffmpeg-export.test.ts`), and publishes a GitHub release holding the installer, FFmpeg's source archive and the runtime's `build.json`, with its notes taken from `CHANGELOG.md`. Releases up to v0.1.1 were pre-releases; from v0.1.2 each is the latest release, which `releases/latest` and winget point to. It also builds the Microsoft Store package of the same build and keeps it with the run as the `store-package` artifact ("Microsoft Store"). A push to the `release-check` branch runs the same build and publishes nothing. The installer stays unsigned until a signing route is chosen ("Signing"); update metadata is not published yet.

## Packaging

`npm run package` builds the app and packs it with electron-builder (`scripts/package-desktop.mjs`) into a per-user NSIS installer, `build/release/usee-<version>-setup.exe`, beside `build/release/win-unpacked/`. The staged app holds only the bundled main, preload and renderer and a `package.json` naming the main bundle: esbuild and Vite bundle every dependency, so no `node_modules` and no source maps ship, and electron-builder records the ASAR's integrity in the executable. Resources hold the recorder host (`node scripts/build-native.mjs` first) and, only when a legal review has accepted an FFmpeg runtime and `apps/desktop/src/main/ffmpeg-runtime-trust.ts` holds its manifest's SHA-256, that runtime with its manifest and license (docs/decisions/ADR-008). Until then the installed app records and edits, and its export panel and Settings say the encoder is not installed; the script says which it built. Beside `usee.exe` it puts usee's licence (`LICENSE.txt`, MIT), its privacy policy (`PRIVACY.txt`, from `PRIVACY.md`) and `THIRD-PARTY-NOTICES.txt`, the licence of every package bundled into the app, taken from the lockfile's runtime dependencies (a bundled package without a licence file stops the build); Electron adds its own licence and Chromium's. The executable, the installer and the uninstaller carry usee's icon, `apps/desktop/build-resources/icon.ico`, drawn for every size Windows shows (16 to 256 px, the small ones on the pixel grid) by `scripts/build-icon.mjs` (`npx electron scripts/build-icon.mjs`), which also writes the README's mark; an unpackaged window shows it too. The installer and executables are unsigned until signing credentials are configured, and with no update feed yet, nothing is published: the block map electron-builder writes is not served anywhere.

## Signing

usee is free, open-source software (MIT), and its releases are not signed yet, so Windows SmartScreen warns when an installer is first run. The plan was the SignPath Foundation's free programme for open-source projects ([signpath.org](https://signpath.org/terms)), which accepts a project only once it has released. In November 2026 the Foundation declined usee's first application: the project was new, with no reviews yet. usee can apply again once it has users and a history. The programme's terms, as read on 2026-11-18:

- The certificate is issued to SignPath Foundation, which Windows names as the publisher.
- Every signed file must come from an automated build of the public repository's source, which SignPath verifies, and a maintainer approves each release by hand.
- Maintainers use two-factor authentication on GitHub and on SignPath.
- The project's home page carries a code signing policy, with SignPath's attribution, the team's roles and a privacy statement.
- Only the project's own binaries are signed. Upstream binaries such as `ffmpeg.exe` ship unsigned inside the signed installer.

A signed build still starts without SmartScreen reputation, with an OV or an EV certificate alike, and gains it as people install it. The other routes, as checked on 2026-11-21:

- The Microsoft Store signs a package it accepts with Microsoft's certificate, and an app installed from the Store gets no SmartScreen warning. An individual developer account is free. usee's Store package is described under "Microsoft Store". A free listing leaves ADR-012 as it is; selling usee would first need the review with a lawyer that ADR-012 asks for.
- A certificate in the owner's own name, such as Certum's open-source code signing certificate (from €69 a year in Certum's shop), names the owner as the publisher.
- Azure Artifact Signing (formerly Trusted Signing) takes individual developers in the United States and Canada only, so it is not open to usee's owner.

## Microsoft Store

usee's Store product, a free listing, is "Usee 3D Motion - Screen Recoder" in Partner Center (Store ID 9N7GB8LD2G62). `npm run package:store` (`scripts/package-desktop.mjs --store`) packs the same staged app as the installer into `build/release/usee-<version>-store.appx`, with the identity Partner Center's Product identity page gives: `techuhat.Usee3DMotion-ScreenRecoder`, publisher `CN=20FA8C00-8CAA-408F-9AC1-DA779DD34040`, publisher display name `techuhat`. Its display name must be one of the names reserved for the product. The package is unsigned: the Store signs what it accepts. It asks for two capabilities, `runFullTrust`, which every desktop app needs, and `microphone`; the recorder host captures through Windows.Graphics.Capture with the border Windows draws, which needs no capability. It runs on Windows 10 version 2004 (10.0.19041) or later. Its images, in `apps/desktop/build-resources/appx/`, come from `scripts/build-icon.mjs` with the icon: the icon at 100 and 200 % for the Store, the taskbar's sizes (16 to 256 px, also marked unplated, as the icon carries its own plate) and Windows 10's Start tiles. electron-builder packs it with the Windows SDK 10.0.26100 tools (`toolsets.winCodeSign` 1.1.0), as the older default bundle's `makepri.exe` fails on Windows 11 when it indexes the images.

Release CI builds the Store package from the same build as the installer, FFmpeg included, and keeps it with the run as the `store-package` artifact; the owner uploads it in Partner Center, under Packages in a submission. Each submission needs a higher version than the last. What the listing says, field by field, with its screenshots and the 300 px tile icon, is in [store-listing.md](store-listing.md).

Inside the package, Windows keeps new folders an app makes under AppData in the package's own folder (`%LOCALAPPDATA%\Packages\techuhat.Usee3DMotion-ScreenRecoder_4d2wyw171xb1c\LocalCache`) and removes them with the app, while a folder that already exists, such as `%APPDATA%\usee` from the installer, is used where it is. Registered from its unpacked package on 2026-11-21, on a machine with the installer's data, usee started, wrote to `%APPDATA%\usee` and connected to its host. Recordings in `Videos\usee` are outside AppData either way. PRIVACY.md says so.

## Updating

Use a signed, HTTPS-only update feed with phased rollout and rollback controls. Electron packaging/updater implementation is selected during the release vertical slice; it must support per-user NSIS install, code signing, delta/full fallback policy, and atomic compatibility across shell/host/FFmpeg versions. Never ship an updater key in the client.

## Configuration layers

| Layer                     | Location                               | Examples                                              |
| ------------------------- | -------------------------------------- | ----------------------------------------------------- |
| Build configuration       | versioned repo config                  | Electron build target, C++ toolchain, FFmpeg manifest |
| Environment configuration | CI/local `.env` excluded from git      | signing credentials, update endpoint secrets          |
| Application configuration | versioned source defaults              | logging level defaults, supported preset identifiers  |
| User settings             | OS app-data store                      | preferences, recent projects, opt-in diagnostics      |
| Project settings          | `manifest.json`                        | timeline/effect/export intent, never machine secrets  |
| Feature flags             | versioned settings/remote policy later | gated, fail-closed experiments                        |

Development, test, and production use separate configuration validation. Secrets are never embedded in renderer bundles, project files, logs, or committed `.env` files.
