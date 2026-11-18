# Dependency management

## Policy

The repository uses npm workspaces because it is available with the supported Node runtime (22.13 or newer) and keeps the foundation build reproducible without a second package-manager bootstrap. Workspace packages depend on each other with `"*"`, which npm links locally; the `workspace:` protocol is pnpm/Yarn-only and breaks `npm install`. Every version is pinned exactly (`.npmrc` sets `save-exact`) and `package-lock.json` is committed. Runtime, development, native, and optional dependencies are documented separately; no package is introduced solely for convenience when a small local abstraction is clearer.

| Dependency              | Category                         | Why                                                               | Alternative / risk                                              |
| ----------------------- | -------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------- |
| Electron                | Runtime/dev shell                | Windows packaging, Chromium preview, mature process/IPC lifecycle | Tauri; larger baseline memory, mitigated by process separation  |
| React + React DOM       | Renderer runtime                 | Declarative editor UI and mature tooling                          | Solid/Vue; team/product choice, no domain coupling              |
| Vite + esbuild          | Development/build                | Vite builds and serves the renderer; esbuild bundles main/preload | electron-vite; one less dependency, revisit if dev reloads hurt |
| Zustand                 | Renderer runtime                 | Small scoped view-state stores (ADR-005), from Phase 1            | Plain React state; no global store                              |
| Playwright              | Dev/test                         | Drives the real Electron app in end-to-end tests                  | WebdriverIO; Electron support is marked experimental            |
| TypeScript              | Dev/build                        | Strict types across UI, main, domain, contracts                   | None for this strategy                                          |
| Zod                     | Runtime boundary validation      | Safe untrusted IPC/project DTO parsing and inferred types         | Valibot/JSON Schema; monitor bundle size and schema duplication |
| Vitest                  | Dev/test                         | Fast TypeScript unit test runner                                  | Jest; no runtime product dependency                             |
| ESLint + Prettier       | Dev quality                      | Executable style and safety rules                                 | Other linters; config is deliberately minimal                   |
| C++/WinRT + Windows SDK | Native build                     | WGC, D3D11, WASAPI, Media Foundation                              | Rust windows bindings; confined native build/toolchain cost     |
| electron-builder        | Dev/packaging                    | Per-user NSIS installer from the bundled app, ASAR integrity      | Electron Forge; a large build-time tree that never ships        |
| FFmpeg                  | Packaged native optional runtime | Controlled codecs/probe/transcode/export                          | Media Foundation only; limited codec/container breadth          |
| `adapter-ffmpeg`        | Workspace adapter                | Verifies packaged runtime provenance/checksum and hashes plans    | Native Media Foundation adapter; no codec/container breadth     |

## FFmpeg/legal requirements

FFmpeg binary provenance, checksum, enabled components, source availability obligations, notices, and license result are versioned before it is distributed. Default to an LGPL-compatible build unless legal review approves another choice. H.264/H.265 and any third-party codec patent implications also require counsel review; open source licensing alone does not settle patent licensing.

## Upgrade practice

- Dependabot (`.github/dependabot.yml`) opens updates monthly: npm minor and patch versions in one group, Electron and electron-builder each on their own, and the CI actions, which the workflow pins by commit. `@types/node` keeps to the Node major usee runs on (22), so its major updates are ignored. Electron, FFmpeg, native SDK, and build-chain updates require a focused smoke/security review.
- Lockfile changes are reviewed with package changes.
- New Electron/native packages require supply-chain and security review.
- Optional AI/cloud packages must live behind an application port and feature flag; they cannot become a renderer-global dependency.
