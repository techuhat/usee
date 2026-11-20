# Repository structure

```text
.
├─ apps/
│  └─ desktop/                 Electron composition root and React renderer
├─ packages/
│  ├─ domain/                  Pure business model and value types
│  ├─ application/             Use-case ports and command contracts
│  ├─ contracts/               Validated renderer/main and host-control DTOs
│  ├─ project-format/          Persisted manifest schema and migration registry
│  ├─ adapter-recorder-host/   Launches, authenticates and supervises the native host
│  ├─ adapter-project-fs/      Staging, journal recovery and atomic project bundles
│  └─ adapter-ffmpeg/          Verifies the pinned runtime and render-plan hashes
├─ native/
│  └─ recorder-host/           C++/WinRT capture and encoding process; no product logic
├─ config/                     Shared build and release configuration (added with packaging, Phase 7)
├─ docs/                       Architecture, operating rules, ADRs, roadmap, README images
├─ scripts/                    Repository checks; never runtime application logic
├─ site/                       The website, published to GitHub Pages by .github/workflows/pages.yml
├─ tests/                      Cross-package fixtures/integration/e2e homes
├─ .github/                    CI checks, Dependabot, issue and pull request templates
└─ package.json                npm workspace orchestration only
```

| Directory                   | Responsibility                                                         | Must not contain                                                     | Allowed dependencies                                                                        |
| --------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `apps/desktop/src/renderer` | React presentation, scoped view state, preview composition             | Recording, FFmpeg, filesystem, direct IPC primitives, project truth  | `contracts`, `domain` (pure evaluation), `react`, `react-dom`, `zustand`; no Node built-ins |
| `apps/desktop/src/preload`  | Small capability bridge                                                | Business logic, dynamic channel names, Node APIs exposed to page     | `electron` and `contracts` only; no Node built-ins                                          |
| `apps/desktop/src/main`     | Composition root, IPC handlers, adapter wiring                         | Domain rules duplicated from packages, native capture implementation | `electron`, Node built-ins, `contracts`, `application`, adapters                            |
| `packages/adapter-*`        | One infrastructure capability behind an application port               | UI code, domain rules, other adapters                                | Node built-ins, `contracts`, `application` (and `domain`, `project-format` for project-fs)  |
| `packages/domain`           | Entities, value objects, pure math, domain errors                      | Electron/React/Node/FFmpeg/platform imports                          | `contracts` only (shared IDs, time units, `Result`/`AppError`)                              |
| `packages/application`      | Use cases and ports such as `RecordingPort`/`RenderPort`               | Electron handlers, `child_process`, filesystem, UI components        | `domain`, `contracts`                                                                       |
| `packages/contracts`        | Shared kernel: IDs, units, errors, versioned boundary schemas, DTOs    | Domain behavior, platform implementations                            | `zod` only; no workspace package                                                            |
| `packages/project-format`   | Versioned manifest schema, migrations, serialization mapping           | Direct filesystem I/O or cache/media contents                        | `domain`, `contracts`, `zod`                                                                |
| `native/recorder-host`      | Native capture/audio/input/encoder process and protocol implementation | UI code, project policy, FFmpeg command construction                 | Native Windows SDK and versioned protocol only                                              |
| `config`                    | Build, packaging, release, tooling policy                              | Per-machine secrets or user settings                                 | None, except tooling                                                                        |
| `scripts`                   | Deterministic developer/CI automation                                  | Core application behavior or secrets                                 | Node standard library/tooling only                                                          |
| `tests/fixtures`            | Sanitized deterministic media/project test data                        | Personal recordings or production credentials                        | None                                                                                        |

## Dependency graph

```text
renderer ───────► contracts, domain (pure evaluation only)
   │                  ▲
   ▼                  │
desktop main ───► application ───► domain
   │                  ▲              ▲
   └─ infrastructure ┘              │
              ▲                      │
native host ──┴── protocol schema ───┘
project-format ──────────────────────┘
```

No arrow reverses. `npm run check:boundaries` (`scripts/check-boundaries.mjs`) enforces the table above for every source file: allowed workspace packages, third-party packages and Node built-ins per zone; no deep imports; no relative import that leaves its zone (so the renderer cannot reach into `src/main`); every import declared in its `package.json`; and no workspace cycles. A new workspace or source directory fails the check until it has a rule.

## TypeScript projects

Each package has two configs. `tsconfig.build.json` is a composite project that emits `dist/` and excludes tests; `tsconfig.json` type-checks sources and tests together for editors, lint and CI. The desktop app splits into `tsconfig.node.json` (main, preload; Node types, no DOM) and `tsconfig.renderer.json` (DOM, no Node types), so renderer code cannot type-check against Node globals. `npm run typecheck` runs `tsc -b` over all of them; `npm run build:packages` builds only the package outputs. Tests resolve workspace packages to their sources through `vitest.config.ts`, so they never need a prior build.

## Package conventions

- Every package owns one conceptual boundary and exports only from `src/index.ts`.
- Internal files are imported through package-local relative paths; other packages import public package exports only.
- New cross-boundary types start in `contracts` (wire DTO) or `domain` (semantic model), never in `apps/desktop`.
- Adapters are named by capability, for example `adapter-project-fs` or `adapter-ffmpeg`, rather than collected in a generic `utils` or `services` directory.
- Native C++ is compiled and packaged independently in the recording vertical slice. It is intentionally not part of the foundation build.
