# Project storage and format

## Folder format

The portable project unit is a `.screenproj` directory (archiving/export packaging is a separate future decision):

```text
example.screenproj/
├─ manifest.json                 # canonical, versioned semantic project document
├─ media/
│  ├─ originals/                 # managed source media; immutable after import
│  └─ proxies/                   # reproducible preview media
├─ metadata/
│  ├─ sessions/                  # recording-session metadata
│  └─ interactions/              # compressed immutable pointer/click streams
├─ derived/
│  ├─ analysis/                  # focus/scene results with provenance
│  ├─ waveforms/
│  └─ thumbnails/
├─ cache/                        # disposable, excluded from portable copy
├─ renders/                      # user-retained output only when opted in
└─ recovery/
   ├─ journal.ndjson
   └─ checkpoints/
```

All manifest references are relative, normalized, and confined to the project root. External linked media, if introduced later, records an explicit portable/non-portable status and a content fingerprint.

A recording is imported as one file, `media/originals/<session>/recording.mp4`, holding the video and, when recorded, the audio: one video asset (`hasAudio`) and one clip spanning it. Projects from Phase 1, and recordings whose segments could not be merged, keep one asset and one clip per segment instead (docs/recorder-host-protocol.md, "Merging a session").

## Canonical entities

```text
Project
 ├─ assets: VideoAsset | AudioAsset | EventAsset | ProxyAsset
 ├─ recordingSessions: RecordingSession[]
 ├─ timeline: Timeline → TimelineTrack[] → Clip[]
 ├─ effects: EffectInstance[] and parameter/keyframe tracks
 ├─ analysisRuns: provenance + generated tracks
 ├─ settings: ProjectSettings
 └─ history metadata (not full mutable UI state)
```

Use opaque IDs, integer microsecond times, rational frame rates, normalized coordinates, discriminated unions, explicit schema versions, and immutable asset metadata. Cursor events and mouse clicks carry session-relative timestamps and coordinate-space versions. Do not persist sensitive window titles or screen contents in generic metadata.

## Versioning and migrations

- `manifestVersion` is a required integer. The current version is declared in `packages/project-format`.
- Migrations are pure, ordered `vN → vN+1` functions with fixture tests. No migration performs filesystem I/O itself.
- On open, the repository copies the manifest/recovery checkpoint before an irreversible migration, writes a temp manifest, flushes, validates, and renames atomically.
- New readers tolerate optional future fields where safe; unknown mandatory schema versions fail closed with an upgrade/downgrade message.
- Derived artifacts include producer version, input hash, configuration hash, and generated-at time. Invalidated artifacts regenerate rather than mutate canonical project truth.

`readManifest` (`packages/project-format`) runs the steps in `PROJECT_MIGRATIONS` on the raw JSON, oldest first, and validates the result with the current schema. The current version is 11: clips carry effects, project settings carry the cursor and auto-zoom settings, a zoom keeps its poses as keyframes, each of which may turn the picture in 3D, `analysisRuns` holds generated camera tracks, and a click shows in one of several ways. v1 → v2 adds the default cursor settings and changes nothing else; v2 → v3 turns a zoom's one `pose` into its first keyframe, at the zoom's start; v3 → v4 adds an empty `analysisRuns` and the default auto-zoom settings; v4 → v5 turns the cursor's `clickEffect` from on or off into a style, a shown click becoming `ripple` and a hidden one `none`; v5 → v6 adds the default canvas style; v6 → v7 lets a clip carry a `speed`; v7 → v8 lets the cursor carry a `color` and a `spotlight` and the canvas a `motionBlur`; v8 → v9 marks every zoom keyframe as holding (`hold: true`), so a project made before the camera could flow through keyframes moves as it did, and lets a pose pull back to a scale of 0.5, a zoom carry a `lens` and the auto-zoom settings a `turn3d`; v9 → v10 lets the canvas background be the recording itself, blurred, and a video asset carry the `captureLatencyUs` the recorder measured, -250 to 250 ms (ADR-010); v10 → v11 lets a clip carry annotations (ADR-011). v6 → v7, v7 → v8, v9 → v10 and v10 → v11 only change the version: their fields are optional, so an older build refuses the project rather than dropping them. Fixture tests for v1 and v2 check them. A newer version fails with `project.version-newer`. The repository (`packages/adapter-project-fs/src/project-repository.ts`) keeps a migrated project's original manifest as `recovery/checkpoints/manifest-v<N>.json` before writing the new one. Every save decodes the manifest it is about to write and refuses one this build could not open again (`project.invalid`), copies the manifest it replaces to `recovery/checkpoints/manifest.json`, then renames the new one into place.

## Effects

Effects belong to clips (`Clip.effects`) and cover a span of the clip's source media, so splits, ripple deletes and trims carry them with their content. A split gives an effect that spans the cut to both halves, the second with a new ID. A trim hides the part of an effect outside the clip without deleting it. Kinds (`packages/domain/src/effects.ts`):

- `zoom`: ease into its poses (each an anchor point kept in view, a scale, 0.5-8, where under 1 the camera pulls back and the picture shows smaller than its place, and, when the picture turns in 3D, a `rotation` of at most 30° about each axis: `x` moves the top edge away, `y` the right edge, `z` turns it clockwise), follow them, ease back out, seen through its `lens` (a vertical field of view of 15-60°, 30° when absent). One pose holds still. Between keyframed poses the camera flows on one smooth path (a monotone cubic of its log scale, centre and turn, so it never overshoots a keyframe) and stops only at the first and last keyframe and at one marked `hold`; between two stops it moves as a ramp does, the earlier keyframe's easing shaping the move. The editor adds a keyframe where a moving zoom is changed, and the generated camera's keyframes all hold. Zooms apply in the order they begin, each easing from the view before it, so a zoom that begins inside another moves the camera from that zoom's view to its own and back, never through a jump; while held, the zoom that began last decides the view.
- `blur`: keyframed rectangle, ellipse or polygon regions, normalized to the frame, with an intensity. One keyframe is a still mask; between keyframes the regions move linearly. The editor changes a still mask as a whole and adds a keyframe where a moving one is changed.
- `annotation` (since v11, ADR-011): one `shape` drawn over the picture for the effect's span, fading in and out over 200 ms (a quarter of a shorter span): `text` (at most 120 characters centred at `at`, `size` 0.02-0.2 of the frame's height, on a rounded label when `background`), `arrow` (from `from` to its head at `to`) or `box` (an outline at `bounds`), the last two `lineWidth` 0.002-0.03 of the frame's height thick; each in a `#rrggbb` `color`, normalized to the frame and on it.
- `custom`: an extension point with JSON parameters.

The output canvas (`settings.canvas`) is a project setting too: `aspect` (`source`, `16:9`, `9:16`, `1:1` or `4:5`), `background` (a `solid` colour, a `gradient` from one colour to another at an angle, `blurred-source`: the frame being shown, enlarged to cover the canvas and blurred by `blur`, 0.01-0.15 of the output's smaller side, or an `image` asset), `padding` (a share of the output's smaller side), `cornerRadius` (a share of the picture's smaller side), `shadow` (`opacity`, `blur`, `offsetY`) and an optional `motionBlur` (0-1). A clip's optional `speed` (0.25-4, absent is 1) sets how fast it plays its source; its timeline length is its source span at that speed.

Cursor appearance (`visible`, `size`, `smoothing`, `clickEffect`, and optionally `color` and `spotlight`) is a project setting, not an effect: it changes how the recorded pointer is drawn, never the recording. `smoothing` 0 follows the raw path; up to 1 it averages the path over as much as a fifth of a second either side, as far ahead as behind, so the drawn cursor never trails the real one, never strays more than 4 + 12 x smoothing logical pixels from it (ADR-010), and still lands exactly on each click. `clickEffect` is how each click shows: `none`, `ripple` (a ring spreading out), `pulse` (a dot that pops), `ring` (a ring closing in) or `bounce` (the cursor presses in and springs back).

## Generated camera tracks

Focus analysis (Phase 4) writes one `analysisRuns` entry per recording session with a pointer stream: `kind` `camera-track`, `sessionId`, the generated `zooms` in session time (each a span, its poses and its ramps; IDs start with the session's) and its provenance: `strategy` and `strategyVersion` (the focus strategy and camera planner together: `pointer-focus` 1, clicks and the places the pointer rests, since Phase 6; `click-focus` 2 before it, so an older run is made again), `producer` (the build that ran it), `inputSha256` of the pointer stream file and `generatedAt`. With picture focus on, the strategy is `pointer-picture-focus` 1, and once the editor has read the session's recordings `inputSha256` is the SHA-256 of the pointer stream's SHA-256 and each picture-changes file's, joined with colons in asset order, so new picture changes make the run again. A run is regenerated when the strategy's version or the input's hash changes, never edited: it is derived data, kept in the manifest so overrides can name its zooms. The editor's overrides live in `settings.autoZoom`: `enabled` (the layer shows), `scale` (of every generated zoom), `disabled` (IDs of generated zooms turned off) and `turn3d` (0-1, how far each generated pose turns toward its action: at 1 a lean back of 6° plus up to 12° more toward an action low or high, and up to 15° across toward one left or right; flat when absent or 0). The turn is applied when the layer is composed, so changing it never regenerates a run. Taking a generated zoom over gives each clip it shows over (a cut can run through it) a zoom of its own in its place and turns the generated one off; a clip's own zooms ease from the generated camera and back.

## Interaction streams

A recording made with pointer tracking keeps its raw pointer stream as the session's `event` asset (`eventEncoding: jsonl`): `metadata/interactions/<session>.pointer.ndjson`, the format in docs/recorder-host-protocol.md ("Pointer stream"). `recordingSessions[].interactionAssetId` names it. It is immutable: the smoothed cursor path and click effects are derived from it (`decodePointerStream` in `packages/project-format` reads it, skipping a damaged line). Its times are on the session clock; each recorded video and audio asset says where its own time zero falls on that clock (`sessionStartUs`: 0 for a merged recording, the segment's start for a segment file), so the cursor lines up with any of them. Media without `sessionStartUs` gets no cursor.

## Derived artifacts

`derived/thumbnail.jpg` is the project's picture in the project list: a JPEG of at most 120 000 bytes, 320 × 180, of its first recording a second in (or halfway through a shorter one), letterboxed. The editor makes it in the background when it opens a project the list shows without one; a missing or invalid file only means the list shows a placeholder.

`derived/picture-changes/<asset id>.json` holds where a recording's picture changed, as the editor read it (`packages/project-format/src/picture-changes.ts`): `format` `usee.picture-changes`, `version` 1, `producer`, `algorithm` `cell-luma-v1`, `sampleIntervalUs` (100 000), `generatedAt`, and `changes`, each a time in the recording and a box normalized to its frame (`x` and `y` its centre, `w`, `h`). A recording's media never changes, so its asset ID names the input. A missing or invalid file only means the camera plans without it and the editor reads the picture again.

`derived/waveforms/<asset id>.json` holds an asset's audio peaks (`packages/project-format/src/waveform.ts`): `format` `usee.waveform` (`screen-studio.waveform` before 2026-11-18, still read), `version` 1, `producer` (the host and its version), `algorithm` `peak-abs-u8` (the largest absolute sample of each bucket over all channels, scaled to 0-255), `inputSha256` of the media file, `sampleRateHz`, `peaksPerSecond` (100), `peakCount`, `generatedAt`, and `peaks` as base64. The recorder host writes it when it merges a recording. A missing or invalid waveform only means the editor draws no peaks; regenerating one for an existing asset is not implemented yet.

## Recovery and portability

Recording begins in a staging location with a journal, then imports verified segments into the project. Recovery scans only validated session journals and asks before importing partial work. A portable copy includes `manifest.json`, managed media, metadata, and any non-rebuildable required assets; it can omit `cache` and reproducible proxies/derived files.

User settings are separate from project files. A new recording's project copies the user's new-recording looks (auto zoom, the generated camera's 3D turn, the canvas) into its own `settings` when it is created; later changes to the user settings never change it. Machine-specific paths, recent-project lists, updater information, API credentials, and feature-rollout state never belong in `manifest.json`.
