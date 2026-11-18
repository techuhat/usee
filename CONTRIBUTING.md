# Contributing to usee

Thanks for helping. usee is a free screen recorder and editor for Windows, and every bug report, idea and pull request makes it better for the people who use it.

## Ways to help

- **Report a bug.** Use the bug report form under [Issues](https://github.com/techuhat/usee/issues/new/choose). Steps to reproduce, your Windows version and your graphics card make a bug much quicker to fix.
- **Suggest a feature.** Read [docs/roadmap.md](docs/roadmap.md) first: it lists what is planned, in what order, and what waits for a decision.
- **Send a pull request.** Small fixes can go straight to a pull request. For anything bigger, open an issue first, so we agree on the approach before you spend time on it. Features marked **Decision first** in the roadmap need an architecture decision record (ADR) in [docs/decisions/](docs/decisions) before any code.
- **Improve the docs.** If something here or in `docs/` was unclear to you, it will be unclear to the next person too.

## Set up

| You need                  | Version                                    |
| ------------------------- | ------------------------------------------ |
| Windows                   | 10 (version 2004 or later) or 11, x64      |
| Node.js                   | 22.13 or newer, with npm 10 or newer       |
| Visual Studio Build Tools | 2019 16.11 or newer, with the C++ workload |
| Windows SDK               | 10.0.22000 or newer                        |
| MSYS2                     | Current; only to build FFmpeg for export   |

```powershell
git clone https://github.com/techuhat/usee.git
cd usee
npm install
npm run build:native
npm run dev
```

Export needs an FFmpeg runtime built from source: `npm run build:ffmpeg -- --sources <dir> --msys2 <msys64>` ([ADR-008](docs/decisions/ADR-008-ffmpeg-licensing.md)). Everything else works without it.

## How the project works

- **The docs are the specification.** `docs/` describes how usee is built, and [docs/development-phases.md](docs/development-phases.md) sets the order. When a change makes the code differ from a doc, update the doc in the same pull request. Lasting decisions are recorded as ADRs in `docs/decisions/`.
- **Module boundaries are checked.** [scripts/check-boundaries.mjs](scripts/check-boundaries.mjs) decides what each package may import ([docs/module-boundaries.md](docs/module-boundaries.md)). A new workspace or source directory needs a rule there first.
- **Dependencies are pinned.** Use exact versions. Workspace packages depend on each other with `"*"`, never `workspace:*`, which npm rejects.
- **Tests never use the real screen or microphone.** They record the recorder host's synthetic source (`USEE_SYNTHETIC_SOURCE=1`, set by the test launchers): a 1280 × 720 test pattern, a synthetic pointer and a test tone. Tests on real devices are opt-in.
- **Privacy rules are part of the design.** Never log window titles, never read keystrokes, and never remember the microphone between recordings. Nothing a user records leaves their computer ([docs/security.md](docs/security.md)).

## Before you open a pull request

| What you changed                         | Run                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| Anything                                 | `npm run check`: format, lint, boundaries, typecheck, tests and the build |
| The Electron shell or the preload bridge | `npm run test:e2e`, which drives the built app with Playwright            |
| `native/`                                | `npm run build:native`, which builds the recorder host and runs its tests |
| The picture the editor draws             | Update the preview goldens and look at every image (docs/testing.md)      |

The host integration tests and the end-to-end tests skip when the recorder host is not built, so build it first.

## Commits and pull requests

- Commit subjects follow [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `ci:`, `chore:`.
- Keep a pull request to one topic, and say what changed and how you checked it. The pull request template lists the checks.
- For a change you can see, add a screenshot or a short recording. A recording made with usee is ideal.

## Scripts

| Command                    | What it does                                                          |
| -------------------------- | --------------------------------------------------------------------- |
| `npm run dev`              | Vite dev server and Electron with the development CSP                 |
| `npm run check`            | Every gate CI runs: format, lint, boundaries, typecheck, tests, build |
| `npm test`                 | Unit and integration tests (Vitest), against package sources          |
| `npm run test:e2e`         | Builds, then drives the real Electron app with Playwright             |
| `npm run typecheck`        | `tsc -b` over packages, the desktop app and tests                     |
| `npm run lint`             | Builds the packages' type declarations, then type-aware ESLint        |
| `npm run check:boundaries` | Enforces the import rules in `docs/repository-structure.md`           |
| `npm run build`            | Production build of the packages and the desktop app                  |
| `npm start`                | Runs the last production build                                        |
| `npm run build:native`     | Builds the native recorder host and runs its tests                    |
| `npm run build:ffmpeg`     | Builds the FFmpeg runtime export uses, from its pinned source         |
| `npm run package`          | Builds the Windows installer into `build/release/`                    |

## Repository layout

```text
apps/desktop/             Electron main, preload bridge and React renderer
packages/contracts/       IDs, time units, Result/AppError, IPC schemas (zod)
packages/domain/          Pure product model: project, timeline, effects, recording
packages/application/     Use cases and the ports they need
packages/project-format/  Persisted .screenproj layout and manifest contract
packages/adapter-*/       The recorder host, project files and FFmpeg behind those ports
native/recorder-host/     C++20/WinRT capture process
scripts/                  Repository checks and the native, FFmpeg and installer builds
tests/                    Cross-package integration tests and Electron E2E tests
docs/                     Architecture, operating rules, ADRs and the roadmap
```

## Troubleshooting

- **`npm install` fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.** A firewall that inspects HTTPS is re-signing traffic with a certificate Node does not trust. Install from a network without inspection, or ask IT for the firewall's CA certificate and point npm at it with `npm config set cafile <path-to-ca.pem>`. Do not turn off `strict-ssl`.
- **Electron prints `bad option: --remote-debugging-port` or behaves like Node.** The shell inherited `ELECTRON_RUN_AS_NODE=1`, usually from a VS Code extension. `npm start` and `npm run dev` already clear it; for other commands, run `set ELECTRON_RUN_AS_NODE=` first.
- **Git reports "dubious ownership".** The folder belongs to another Windows account. Run `git config --global --add safe.directory <repo path>`.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE), the same licence as usee.
