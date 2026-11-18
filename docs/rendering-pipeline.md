# Rendering and export pipeline

## Core boundary

```text
Immutable ProjectSnapshot
  → RenderPlanner
  → versioned, hashable RenderPlan
  → PreviewBackend or ExportBackend
  → validated Artifact
```

`RenderPlan` is a semantic description of assets, time ranges, transforms, effects, output intent, and approved preset IDs. It contains no React objects, arbitrary file-system paths, or FFmpeg command text. Preview and export consume the same plan semantics so visual differences are intentional and testable.

The first planner lives at `packages/application/src/render-plan.ts`. It copies only asset IDs and media metadata from the immutable domain project; the worker resolves those IDs inside the already-open project root. Its version-1 plan records timeline and clip timing, speed, effects, pointer/session links, camera analysis, and project canvas/cursor/auto-zoom settings. Before enqueue, `prepareExportJob` freezes that plan and binds its hash to the approved preset and project revision. `EXPORT_PRESETS` in the domain package is an allowlist of output intents, not a promise that the current machine can encode each one. `packages/adapter-ffmpeg` hashes canonical plans, checks the fixed app-owned executable against a build-time trusted manifest hash and its SHA-256, and probes only manifest-approved encoders from a verified runtime. A reviewed runtime binary and app-wired export worker must be in place before a job may run.

## Frame composition

What a frame shows besides its media is one pure function of the domain, `composeFrame(effects, sourceUs, pointer, autoZooms)` (`packages/domain/src/frame-composition.ts`): the camera view of the clip's zooms over the generated camera layer, the blurred regions, and the cursor and click effects from the recorded pointer, all in normalized source coordinates. Blur, cursor and clicks are in the source frame under the camera, so they zoom with the picture; the cursor's size follows the display it was recorded on and the project's cursor settings. A render plan (Phase 7) compiles the same semantics for export.

The camera can turn the picture in 3D and pull back from it: a zoom's poses may tilt, turn and rotate it. A flat camera at a scale of 1 or more is the plain crop, filling the picture's place on the canvas. Otherwise `cardTransform` (`packages/domain/src/camera-transform.ts`) compiles the frame's camera into a card: the camera's flat crop fills a card the size of the picture's place, the card turns about its centre as a lens with the view's field of view (30° unless the view says otherwise) sees it, and a scale under 1 shrinks it about its centre. The canvas shows wherever the card does not cover its place, and the picture's rounded corners and shadow turn and shrink with it.

The frame then sits on the project's canvas: the preview sizes its canvas to the output's shape, paints the background and the picture's shadow, clips to the picture's rounded rect from `pictureLayout` (`packages/domain/src/canvas.ts`), and draws the composed frame inside it. `composeFrame` also reports how fast the camera moves (`cameraMotion`), which the canvas's motion blur turns into a blur of the picture while a zoom eases or pans, and the cursor's colour and spotlight, which dims the picture away from the cursor.

Until then the editor previews directly: the renderer imports the domain's pure evaluators (docs/repository-structure.md) and draws each composed frame onto a canvas over the playing `<video>` with Canvas 2D (`apps/desktop/src/renderer/editor/compositor.ts`): the camera's crop of the frame, each blurred region clipped from a filtered copy, then the click effects (a ripple, a pulse or a ring; a bounce presses the cursor in) and a vector cursor. A frame whose camera turns the picture is composed flat the same way, on a canvas of its own at the detail the card's nearest edge needs (up to four times its place, at most 4,096 pixels wide), then projected onto the canvas with WebGL 2 through the card's transform, sampled with mipmaps so its far side does not shimmer, inside the card's outline after its shadow (`camera-projection.ts`). A pulled-back flat frame is drawn the plain way into its shrunk place. Each frame is taken from the video as a WebCodecs `VideoFrame`, so every layer shows the same frame and its media time is known. While playing, every frame the video presents is drawn at its own media time; paused, the frame is drawn at the playhead once the seek has reached it.

Cursor paths keep this preview responsive on long recordings: the renderer derives a zero-smoothing path as an immediate fallback, then derives the project's symmetric, zero-phase smoothing in a module worker. The worker returns transferable position arrays; stale results are ignored when the stream or smoothing setting changes. The cursor keeps the same 120 Hz sampling, click landing and no-trailing behavior, while Gaussian work stays off the renderer thread.

## Rendering responsibilities

| Layer                    | Responsibility                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Timeline/effects planner | Resolves clips, camera, masks, effects, keyframes and source time into a plan                                                        |
| Preview backend          | Selects proxy/decode path and prioritizes low latency and seekability                                                                |
| Export backend           | Chooses a deterministic quality-oriented pipeline, validates output, publishes atomically                                            |
| FFmpeg adapter           | Converts an approved plan/preset into the only permitted argument vector, launches the controlled executable, parses progress safely |
| Native GPU/media adapter | Capability probes, D3D11/Media Foundation operations, hardware codec selection/fallback                                              |
| Job manager              | Queue, priority, cancellation, retry policy, persisted diagnostics, crash recovery                                                   |

`ExportCoordinator` persists prepared jobs and lifecycle changes through `ExportJobStorePort`. The filesystem adapter validates a versioned path-free plan snapshot and atomically replaces the queue file. The coordinator retains at most 100 terminal jobs by default and keeps pending jobs regardless of that limit. On startup, a queued job is requeued only after its plan hash and preset are verified; a job persisted in an active state becomes `failed` with `export.interrupted`. Desktop composition uses a main-process save dialog, keeps destination paths out of renderer IPC, resolves managed media IDs in main and leases media URLs for each job. The renderer receives at most two outstanding frame requests, so it finds and composes the next frame while main writes the last, seeks its videos for them one at a time in order, and submits for each a bounded typed array of raw RGBA pixels, which the worker accepts only at exactly the output's size; a 30-second deadline and FFmpeg stdin backpressure limit buffering. A dedicated renderer worker decodes each recording in order with WebCodecs, reading its sample tables and samples from `app://media` in byte ranges (`mp4-index.ts`, `export-video-decoder.ts`); a recording it cannot decode is sought in separate video elements instead, never the preview's. It applies the preview's camera, cursor, blur and canvas composition and transfers the canvas's pixels to main, which FFmpeg converts to YUV with the BT.709 matrix players show HD video with, and tags so; encoding a PNG instead took as long as the rest of the frame. `ExportArtifactPublisherPort` and its filesystem adapter verify the job-owned MP4's size and SHA-256, stage a second verified copy beside the chosen destination, and atomically create the final name without replacing an existing file; the source remains available for recovery. A destination race fails with `export.destination-exists`. A partially written output is never treated as complete. Runtime approval, signed packaging and measured performance/soak gates remain open.

## Render-job lifecycle

```text
Queued → Preparing → Rendering → Validating → Publishing → Succeeded
                    ↘ Canceled
                    ↘ Failed (typed category + retained diagnostics)
```

- A job snapshots the project revision and export preset at enqueue time.
- Cancellation is cooperative: stop at a safe media boundary, terminate worker descendants, remove only job-owned temporary files, preserve source assets.
- `Publishing` validates the worker-owned output, stages and verifies a copy beside the target, then atomically creates the final name without replacing an existing file. The application chooses a destination before calling the publisher; a race with another file creation fails safely with `export.destination-exists`.
- A resumed job never assumes a partially written export is valid; it re-probes or restarts deterministically.

## Hardware and quality policy

Probe device/driver/capability at runtime. The initial preset vocabulary includes container, codec family, pixel format, resolution, frame rate, bitrate/quality mode, audio settings, and hardware preference—not raw encoder flags. Planned presets include 1080p/1440p/4K, 30/60 FPS, H.264/H.265, and WebM. Availability is capability- and licensing-dependent.

GPU acceleration is opportunistic and observable. A driver/encoder fault falls back to a safe supported path and records why. Export is background work with limited concurrency; it never blocks Electron's main or renderer thread.

## FFmpeg policy

FFmpeg is used for probing, proxies, decode/transcode, muxing, and eligible composition/export work. It is packaged with a pinned build manifest, SHA-256, source provenance, enabled codec list, notices, and license decision. The default distribution target is LGPL-only unless legal review explicitly approves a different build; enabling GPL components changes the distribution obligations. Review [FFmpeg's legal guidance](https://ffmpeg.org/legal.html) before altering the build.

Do not blindly use a generic system `ffmpeg` from `PATH`. The adapter resolves an application-owned executable, validates it against the manifest, creates a fixed safe working directory, and receives only structured jobs. It never accepts a command line from IPC or a project file.

## Temporary files and crash recovery

```text
project/.work/render-<job-id>/
  ├─ plan.json
  ├─ inputs.lock
  ├─ progress.ndjson
  ├─ partial-output.*
  └─ diagnostics.json
```

The job owns this directory and records a cleanup lease. Startup cleanup removes only stale, validated job directories; it must never recursively delete a broad project/cache path. Source media, project manifests, and user-selected exports are never temporary files.
