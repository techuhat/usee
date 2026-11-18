# Development phases

## Phase 0 — Foundation (complete, 2026-10-17)

- Architecture and ADRs approved.
- Workspace, strict TypeScript, lint, formatting, boundary checks, tests, and CI scaffold established.
- Domain/application/contracts/project-format placeholder types established.
- Secure blank Electron shell builds successfully.
- No capture, recording, editor, auto-zoom, effects, FFmpeg workflow, or packaging feature implemented.

Exit check: `npm ci && npm run check && npx playwright test --config tests/e2e/playwright.config.ts` passes on a clean checkout.

## Phase 1 — Recording vertical slice (complete, 2026-10-17)

Implement one display capture path, optional microphone, native host handshake/lifecycle, staged segments, recovery journal, and a minimal project import. Benchmark 1080p/60 before adding breadth. Do not add editor effects yet.

Exit check: the Phase 0 check, plus `npm run build:native`, with the host integration and recording E2E tests passing; a real-microphone recording verified on the device; and the 1080p/60 benchmark recorded (dropped frames, encoder, memory). All passed; the baseline is in [performance-budget.md](performance-budget.md).

Carried forward: an intermittent host start failure seen under full-suite load (the tests now print the host's warnings), encoder rate-control tuning (about 25 Mbps against a 12.4 Mbps target), and the 30-minute soak and A/V drift runs.

## Phase 2 — Project, proxy, and timeline core (implemented 2026-10-17; the owner asked to continue)

Implement project repository/migrations, asset catalog, proxy/waveform derivation, semantic timeline commands, undo/redo, and an interactive preview with a single clip.

Built on branch `phase-2-editor`:

- Each finished recording is remuxed into one MP4 (video plus its own audio) with a derived waveform, so it is one asset and one clip. The manifest's asset list is the catalog the editor reads.
- Projects open, migrate (ordered pure steps; none exist yet) and save atomically, keeping the replaced manifest as a recovery checkpoint.
- A main-process project session applies split, ripple delete and trim, keeps 100 undo steps, and saves every change in the background.
- The editor previews over `app://media` with range requests and shows the timeline with waveforms.

Deviations, stated when the phase started:

- No proxies yet. Recordings are at most 1080p H.264, which Chromium decodes in hardware, so the preview plays the originals. Proxies arrive with imported or larger media.
- No FFmpeg. The recorder host remuxes and decodes with Media Foundation; FFmpeg arrives with export in Phase 7.

Known limits: the preview plays one track, so a Phase 1 project's separate microphone track is not heard; a deleted waveform is not regenerated. (Timeline zoom, missing at first, came with the Phase 3 follow-ups.)

Exit check: the Phase 1 check, plus `tests/e2e/editor.spec.ts`, which records, splits, deletes, undoes and redoes, then checks the saved manifest and a reopen.

## Phase 3 — Cursor and basic effects (implemented 2026-10-18, awaiting review)

Add immutable interaction ingestion, cursor derivation, click visualization, 2D camera/zoom, manual keyframes, and reusable blur masks. Add visual golden tests.

Built on branch `phase-3-effects`:

- The recorder host records the pointer (position, buttons and cursor kind, never keys) into an append-only stream beside the media (protocol 1.2), kept as the session's immutable `event` asset; each recorded asset says where it sits on the session clock.
- Manifest version 2 adds clip effects (zoom, blur, custom), kept in source time so edits carry them, and the project's cursor settings; version 1 projects migrate.
- The domain evaluates any moment of a clip (`composeFrame`): the camera of its zooms, each easing from the view before it; blur masks between keyframes; the smoothed cursor, which lands on every click; and click ripples.
- The preview composites every frame on a canvas from a WebCodecs `VideoFrame`: zoom, blur, ripples and a vector cursor for each standard cursor kind.
- The editor adds zooms (aimed at the cursor) and blurs at the playhead, shows them on the timeline to move and retime, edits them in an inspector and on the picture, keyframes zooms and blur masks, and sets the cursor.
- The timeline zooms in to about seventeen pixels a frame (its buttons, or Ctrl and the wheel) and scrolls, following the playhead; only the visible part of a waveform is drawn.
- The editor fills the window and never scrolls: the picture takes the room the header, toolbar and timeline leave, and the window opens at 1360 x 900.

Deviations, stated as they were made:

- The renderer imports the domain's pure evaluators, so the preview draws the frame semantics export will compile (docs/repository-structure.md). Render plans are still Phase 7.
- Manual camera keyframes are a zoom's poses: the camera pans and changes scale between them inside one zoom. Phase 4's camera track, generated from clicks with manual overrides, builds on them.
- Media allows CORS for the app's own renderer origins, so the preview can read the frames it plays.

Known limits: polygon masks are drawn but not edited in the editor, which edits a mask's first region; an application's own cursor is drawn as the arrow; automated tests record the synthetic pointer, so the real mouse's tracking still needs one recording checked by hand.

Exit check: the Phase 2 check, plus the preview goldens (`tests/e2e/preview.spec.ts`) and `tests/e2e/effects.spec.ts`.

## Phase 4 — Focus intelligence and 3D camera (implemented and reviewed 2026-10-19)

Introduce click-based focus candidates, generated camera tracks with provenance, manual overrides, and the camera-pose renderer. Add further strategies only behind the focus interface.

Built on branch `phase-4-focus`:

- Click-based focus: every left or right click on the captured display is a focus candidate, behind the `FocusStrategy` interface.
- The camera planner turns candidates into zooms: clicks less than 4 s apart share one zoom, which closes in a second before the first, pans to arrive just before each click and holds there until the next pan, and stays 1.5 s after the last.
- Manifest version 4 keeps one generated camera track per recording session in `analysisRuns`, with its provenance (strategy and version, producer, input hash, time). It is made when a project opens and made again only when the pointer stream or the strategy changes.
- The preview draws the generated camera under the clip's own zooms, which ease from it and back. The timeline shows each generated zoom in its own lane; one can be turned off, or taken over as the clip's own zoom to aim, retime and keyframe. The sidebar turns auto zoom off for the project and sets its depth. Every override is an undoable command; the analysis itself is not.
- A zoom's keyframes are full camera poses: besides where the camera looks and how close, each can tilt, turn and rotate the picture in 3D, up to 30° about each axis, and the camera moves between them. The domain compiles each frame's pose into a projective transform (`cameraTransform`), closing in only as far as a turn needs to keep the picture filling the frame. The preview draws a turned frame by composing it flat and projecting it with WebGL 2; the zoom's frame over the picture shows what the camera sees.

Deviations, stated as they were made:

- Focus analysis runs in the main process as a project opens, not in a worker: the click strategy takes milliseconds. A heavier strategy gets a cancellable worker behind the same interface.
- The perspective is one fixed lens (a 30° field of view) rather than part of each pose; the camera moves closer as it zooms in, so a turn looks equally deep at any scale.
- A turned picture never shows past the frame's edges, since there is nothing to show there yet (backgrounds come in Phase 5).

Known limits: only clicks drive the generated camera, and it never turns the picture; a turned frame in the preview is drawn from a flat composition at about the output's resolution, so its far side is a little softer.

Exit check: the Phase 3 check, plus `tests/e2e/auto-zoom.spec.ts` and the generated-camera and turned-zoom goldens in `tests/e2e/preview.spec.ts`.

The owner's review (2026-10-19) brought these follow-ups, on branch `phase-4-review`:

- The cursor no longer trails the real pointer. Smoothing used to be a spring that lagged about 60 ms behind and caught up around each click, which felt sluggish and sticky; it now averages the path as far ahead as behind, so it has no lag, and eases onto each click without speeding up or stalling.
- Clicks show in one of five ways, chosen in the cursor panel: none, ripple, pulse, ring or bounce (manifest version 5).
- The product is named usee: the window, its folders (`Videos\usee`, `LocalAppData\usee`) and its messages. An earlier build's folders moved there on its first start. That move went on 2026-11-18, when the working title also left the code before usee was published as open source: packages are scoped `@usee/`, and recordings made under the old name still open.
- The owner added Phase 5 below; export is now Phase 6.

## Phase 5 — Canvas styling and speed (implemented 2026-10-20, awaiting review)

Added by the owner on 2026-10-19. Put the recording on a styled canvas, and let parts of it play faster or slower: a background (a solid colour, a gradient or an image), padding around the picture, rounded corners and a shadow; the output's aspect ratio (the source's own, 16:9, 9:16, 1:1 or 4:5), with the camera and its 3D turn working inside it, where a turned picture may show the background past its edges; and speed changes on clips that the timeline, the preview and the audio follow. All of it is project data, which the render plans of Phase 7 compile the way the preview draws it. The owner also asked for a cursor colour, a spotlight and camera motion blur.

Built on branch `phase-5-canvas`:

- The project's canvas style (manifest version 6): the output's shape, a solid or gradient background, padding, corner radius and a drop shadow. `pictureLayout` in the domain places the picture: inset by the padding, fitted to keep its shape, centred. The preview paints the background and shadow, clips to the rounded picture and draws the frame, flat or turned in 3D, inside it. While an effect is edited the picture shows plain, so its handles line up. The inspector's Canvas tab sets it all.
- Clips play from 0.25× to 4× (manifest version 7). A clip's timeline length is its source span at its speed, and split, trim, delete and the new `set-clip-speed` work in timeline time and ripple. The preview sets the video's playback rate, so the sound keeps up and keeps its pitch. A selected clip's speed is set in the inspector.
- The cursor takes any colour and a spotlight that dims the picture away from it; the canvas a motion blur that blurs the picture while the camera moves, in proportion to its speed (manifest version 8).

Revised on branch `phase-5-review`, after the owner's first look:

- The preview resamples the picture at high quality, so text under a zoom stays clean while the camera moves instead of shimmering.
- The editor's sidebar is a tabbed inspector: Edit (the selected clip, zoom or blur, or a hint when nothing is selected), Canvas, Cursor and Camera (auto zoom). Selecting something on the timeline opens Edit. Choices among a few options are segmented buttons, colours and backgrounds are swatches, and on/off settings are switches; the tabs and every group move with the arrow keys. One accent colour, a camera's tally amber, marks what is live or chosen: the playhead, the selection, the active tab and the preview's frame while it plays.
- The owner added Phase 6, 3D motion, below; export is now Phase 7.

Known limits: an image background is in the format and drawn when given its bitmap, but the panel offers only solid colours and gradients; the 3D turn still keeps the picture filling its inset rather than showing the background past its edges (Phase 6 brings that).

Exit check: the Phase 4 check, plus `tests/e2e/canvas.spec.ts` and `tests/e2e/speed.spec.ts`.

## Phase 6 — 3D motion (implemented 2026-10-22, awaiting review)

Added by the owner on 2026-10-20, after the public description of FocuSee's 3D Motion, and built independently: no FocuSee code, assets or branding (docs/architecture.md). Give the camera depth on its own, and full control over it when wanted:

- One-click 3D motion: one switch gives the generated camera 3D motion. It pushes in toward each action with a gentle turn toward it, glides between actions and pulls back out after the last, so a recording gets depth with no keyframing. How far it turns is a project setting.
- Smarter focus: besides clicks, the generated camera can follow where the pointer rests and where the picture changes (typing, a menu or a dialog opening), found from the recorded pointer and frames, never from keystrokes. Each is a further `FocusStrategy` with its own version in the run's provenance; a heavy one runs in a cancellable worker.
- Presets: a selected zoom takes a built-in 3D move in one click, such as push in, pull out, tilt up, swing in from the side or orbit. A preset writes the zoom's keyframes as one undoable edit, and each keyframe stays editable.
- Custom 3D: each keyframe still sets where the camera looks, how close it is and how it tilts, turns and rotates; a zoom can also choose a wider or narrower lens for more or less perspective, and the picture can be turned by dragging on it, not only with sliders.
- Smooth paths: the camera flows through a zoom's keyframes on one smooth path instead of stopping at each, unless a keyframe is set to hold; motion blur follows the 3D move.
- The picture floats in 3D: a turned picture shows the canvas background past its edges, its rounded corners and shadow turn with it, and a pull-out can show the whole picture smaller than the frame.
- Sharper turned frames: the preview composes a turned frame at the resolution its nearest edge needs, so the near side stays as sharp as a flat frame.

All of it is project data (manifest version 9), which the render plans of Phase 7 compile the way the preview draws it.

Built on branch `phase-6-3d-motion`:

- A turned or pulled-out picture floats over the canvas as a card (`cardTransform`): the camera's flat crop fills a card the size of the picture's place, turned about its centre through the view's lens, and shrunk under a scale of 1; its rounded corners and shadow turn with it, and the canvas shows past its edges. A turned card is composed at the detail its nearest edge needs and sampled with mipmaps. The camera no longer closes in to hide a turn.
- Manifest version 9: a pose may pull back to a scale of 0.5, a zoom may have a lens, a keyframe may hold, and the auto-zoom settings may turn the generated camera. The v8 → v9 step marks every existing keyframe as holding, so older projects move as they did.
- The camera flows through a zoom's keyframes on a monotone cubic path and stops only at the first, the last and any that hold; the inspector's Keyframes section has a Hold here switch. A turn counts as camera motion, so motion blur follows 3D moves.
- A lens per zoom: the inspector's Perspective chooses gentle (20°), normal (30°) or strong (50°).
- 3D presets (`presetKeyframes`): push in, pull out, tilt up, swing and orbit write a zoom's keyframes over its body in one undoable edit.
- A turn handle on the zoom's frame turns the picture by dragging (across turns, up and down tilts), and the frame shows the turn leaning it.
- One-click 3D motion for the generated camera: the Camera tab's switch turns each generated pose toward its action, as far as its Turn slider says (`turnToward`), without regenerating the run.
- The default focus strategy is `pointer-focus` 1: clicks, and where the pointer rests somewhere new for 0.7 s or more without a click.

Deviations, stated as they were made:

- Focus where the picture changes (typing, a menu or a dialog opening) was not built at first. It needs the recording's frames decoded, and both ways to do it cost something the owner should choose: the native host could analyse the merged recording as it does the waveform, adding about a minute of software decoding per five minutes of recording to every import, or the editor could analyse it in the background with the video it already decodes in hardware, which needs a new bridge call and storage for the result. No new npm package could be added here either way.
- Built on 2026-11-08 the second way, once export could decode recordings in order with WebCodecs and the owner asked for the rest to be finished: with the setting "Follow changes on screen" (the 3D camera tab or Settings; off by default, for every project), the editor reads each recording the camera follows in a background worker, ten frames a second, as the mean luma of a 32 × 18 grid (`picture-change-analysis.ts`). Cells that change together within half a second are a change, so typing a character at a time still makes a line; a single cell is noise, such as a caret, and a cell changing in most of the last two seconds is an animation and is left out. Main keeps what it found as `derived/picture-changes/<asset id>.json` and plans the camera again with `pointer-picture-focus` 1: clicks, rests, and each change small enough to be a place (under 40 % of the frame), once per place while it keeps changing, weighted below both. Keystrokes are never read.
- The turn handle is mouse-only; the inspector's sliders turn the picture from the keyboard.

Known limits: the generated camera's 3D turn is fixed by where each action is, not by what is on screen; presets look where the zoom's first pose looks.

Exit check: the Phase 5 check, plus `tests/e2e/motion3d.spec.ts`, which turns the generated camera toward each action, drags the turn handle and undoes it, applies the orbit preset and undoes and redoes it, chooses a strong lens, and checks goldens of the generated camera turned at a click, the orbit mid-move and a pull-out over a light canvas, then reads the saved manifest.

## Phase 7 — Export and hardening (in progress, 2026-11-06)

Implement render plans, controlled FFmpeg adapter, export queue/presets, hardware capability selection, cancellation, failure recovery, packaging, update signing, soak tests, and performance regression gates.

The features usee works toward, drawn from public descriptions of commercial screen-recording editors, and their order are in [roadmap.md](roadmap.md). Phase 7 remains the next exit gate; later features belong in Phase 8.

Started on branch `phase-7-export`:

- `compileRenderPlan` builds a versioned, path-free render plan from a project and an approved preset ID. It carries the timeline, clip timing/speed/effects, used media metadata, pointer/session links, generated camera runs, and canvas/cursor/auto-zoom settings.
- `prepareExportJob` canonicalizes the approved preset, copies and freezes the compiled project revision, and binds its SHA-256 plan hash to the queued request. Desktop wiring saves the project before queueing and keeps the destination path in main behind the native save dialog.
- The first approved profiles are MP4/H.264 at 1080p30, 1080p60, 1440p30, and 4K30. They express output intent only; encoder availability remains unavailable to the app until the verified-runtime probe is wired into its composition root.
- `adapter-ffmpeg` hashes canonical plan JSON and verifies the runtime only at the fixed app resource path. A build-time trusted manifest hash, manifest schema, nonsymlink path check, and executable SHA-256 must all pass before main-process code receives the path.
- The adapter probes a verified runtime with fixed `-encoders`, `-muxers` and `-decoders` invocations, intersects the encoders with manifest-approved ones, refuses a runtime missing anything the export commands use (`export.ffmpeg-runtime-incomplete`), and returns typed failures with bounded output and timeout handling. Desktop startup performs verification and probing; export stays disabled when the release trust anchor or runtime is absent.
- `ExportCoordinator` accepts prepared jobs, verifies their plan hash and approved preset, runs one worker at a time, validates worker progress transitions, exposes status updates, and supports cooperative cancellation. It retains at most 100 terminal jobs by default while preserving all pending work. With `ExportJobStorePort`, it atomically persists lifecycle transitions, requeues validated queued jobs, and marks interrupted active jobs failed on restart. Desktop composition connects it to the filesystem store and a sanitized queue UI.
- `ExportArtifactPublisherPort` and the filesystem adapter validate the job-owned artifact's byte count and SHA-256, verify the staged destination copy, then atomically create the final name without replacing an existing file. The adapter preserves the job-owned source; a destination race returns `export.destination-exists`.
- `createFfmpegExportWorker` streams renderer-composed PNGs one at a time with cancellation and backpressure, applies audio clip timing/speed, encodes on the GPU's Media Foundation H.264 encoder at the preset's bitrate (CBR, High profile, NV12) and, if that fails, again from the first frame on Windows' software encoder, decodes the finished MP4 for validation with `-xerror` so any decode error fails it, hashes it and publishes it. A renderer module worker composes each frame; separate video elements keep export seeks away from the live preview.
- The editor now offers quality selection, a main-process save dialog, queue status/progress and cancellation. Managed media is resolved by asset ID; leased `app://media` URLs and pointer tracks support a queued job after its project closes or the app restarts.
- Cursor smoothing runs in a renderer module worker while an immediate zero-smoothing path is available; focus rest detection scans sorted clicks and pointer rests in O(M + C) after sorting instead of rescanning all clicks for each rest group.
- ADR-008 records FFmpeg 9.0.2 as an unapproved Windows x64 build candidate. Its archive signatures, sources and zlib were verified on 2026-11-07, and ADR-008 records the configure command the export commands need: the first candidate build lacked the mp4 muxer and the validation encoders, so every export would have failed. A build with the corrected command passes `tests/integration/ffmpeg-export.test.ts`. The release build, its manifest, codec/patent review, and distribution approval remain open. No FFmpeg binary or runtime manifest is checked in.
- `npm run build:ffmpeg` (`scripts/build-ffmpeg.mjs`) builds the runtime from the pinned, verified sources with ADR-008's configure command and Control Flow Guard, checks the binary reports the LGPL and that configuration, and writes it with its licenses and provenance; the runtime manifest only once a legal review is named. An unpackaged build exports with this output and its development manifest; a packaged one only with its own reviewed runtime.
- Export works end to end in a development build: `tests/e2e/export.spec.ts` exports a recording through the Export panel to an MP4 that decodes cleanly, H.264 High at 1080p with AAC and the project's length, and cancels a second export without leaving a file. Running it found that the worker returned the publish unawaited inside `try/finally`, so its cleanup deleted the output while the publisher was still checking it and every export failed; it now awaits, and lint (`@typescript-eslint/return-await`) refuses the pattern.
- Measured (development machine, AMD Radeon integrated GPU): a 3.5-second recording exported at 1080p30 in about 14.4 s, a quarter of real time. Timing each frame (136 ms) showed two equal costs: seeking the source video to the frame (about 55 ms) and encoding the composed canvas as a PNG (about 55 ms); composing it took 1 ms and sending it 2 ms.
- Export frames are now the canvas's raw RGBA pixels (2026-11-08). On their own they were slower, 17.6 s: reading the pixels back from the GPU took about 35 ms and sending 8 MB to FFmpeg about 48 ms, more than the PNG they replaced. Main now asks for two frames ahead of the one FFmpeg is reading, so the renderer seeks and composes while the last frame is written, and the same export takes about 13 s. Raw frames stay: their cost does not grow with what is on screen as a PNG's does, and FFmpeg no longer parses an image the renderer made. Seeking the source video for every frame then bounded export: a recording has a keyframe every 2 s, so each seek decoded about 60 frames.
- Export decodes recordings in order with WebCodecs (2026-11-08, at the owner's request). The export worker reads a recording's `moov` and samples from `app://media` in byte ranges (`mp4-index.ts`, no new dependency) and decodes each frame once, starting over at a keyframe only to go back or to skip past one (`export-video-decoder.ts`). The same export takes about 7.5-8 s, under half the 14.4 s it started at, and seeking no longer bounds it: reading the composed pixels back (~35 ms) and sending them to FFmpeg do. A recording the reader or the decoder cannot handle (fragments, another codec, an edit list that moves the picture, a decode error) is sought in a video element as before, from that frame on. Exporting one project both ways gave the same frames, except where an output frame falls exactly on a source frame's start: the seek path sometimes showed the frame before it, because `currentTime` is set in seconds and Chromium truncates it to microseconds; the decoder takes the frame that starts there.
- Tests cover plan hashing, path exclusion, retimed clip timing, pointer mapping, media/preset validation, trusted-manifest/binary tampering, capability filtering, queue order, progress, failures, and cancellation.

Owner-requested app shell, settings and 3D camera discoverability (2026-11-08, branch `app-shell`), built from the owner's request for a professional Home page, Settings and tools, and their report that the 3D camera could not be found:

- A sidebar with Home, Recordings and Settings. Home records (screen, microphone, frame rate, pointer) and sets what new recordings start with (auto zoom, 3D motion toward each action, a background); Recordings lists every recording with a filter by name and shows the folder; Settings holds the recording defaults, the new-recording looks with auto zoom depth and 3D turn, the export quality, the recordings folder, the keyboard shortcuts and the about and licence notes. The editor takes the whole window and returns to the page that opened it.
- Settings are main's, versioned and validated (docs/state-management.md, "Settings"); three new invoke channels carry them (docs/ipc.md, "Settings"). The microphone is never remembered.
- The 3D camera was there but hidden: its presets only showed with a zoom selected, and the generated camera's 3D motion was off at the end of the Camera tab. The tab is now "3D camera" and leads with the five 3D moves, each drawn, which change the selected zoom or add a zoom with that move at the playhead; then 3D motion, then auto zoom. The toolbar has Add 3D zoom (a swing), and a zoom that moves in 3D is marked 3D on the timeline, as is the generated camera when it turns.
- Recording controls (2026-11-09): while a recording runs the window minimizes, out of the picture (Settings, "Hide usee while recording", on unless turned off), a red dot in the notification area offers Stop recording, and Ctrl+Shift+F10 stops it from any app. The shortcut is registered only while recording and listens for that one combination; keystrokes are never read. As the recording ends the window comes back with the editor on it. Since 2026-11-16 a three-second countdown on the record card comes first (Settings, "Count down 3 seconds first", on unless turned off; Escape or Cancel stops it), and the window goes as capture is prepared, so its going is not in the first frames.
- Filmstrip (2026-11-16): each video clip on the timeline shows its recording's pictures, a tile per keyframe on the clip's own grid, with the waveform along the bottom. A background worker decodes only the keyframes, each on its own (a keyframe every 2 s, so even long recordings read quickly, at most 600 pictures), and sends their pixels; the editor makes the bitmaps itself, since a bitmap made from a decoded frame in a worker belonged to the worker's GPU resources and went blank when it ended.
- Thumbnails (2026-11-09): Home's recent list and Recordings show each recording by a picture of it. The editor decodes one frame of a project the list shows without one, a second in, in a background worker, and main keeps a small JPEG beside the project (`derived/thumbnail.jpg`); the list carries the 50 newest inline.
- Colour and type: deeper surfaces with a darker rail, the amber tally light kept as the accent, a red for recording that white text reads on, and cyan, the other half of red-cyan 3D glasses, for everything 3D; Segoe UI Variable Display for titles and Text for the rest.
- Icon and first start (2026-11-18): usee's icon is the sidebar's mark drawn for every size Windows shows by `scripts/build-icon.mjs` (docs/release.md, "Packaging"). As the window opens, a 1.25-second intro draws the mark, the plate, the lens ring and then the tally light coming on, and zooms past it into the app; it takes no clicks and does not play when Windows asks for less motion. A first start then opens the welcome tour, four steps each with a moving picture: what usee does, what it records and how to stop, what stays private, and the looks new recordings start with. Back, Next, the arrow keys and the step dots move through it; Done, Skip or Escape closes it and saves `welcome.seen`; Settings, under About, shows it again. `tests/e2e/welcome.spec.ts` covers it, and the other specs start with `USEE_SKIP_WELCOME=1`, honoured only unpackaged.

- Export colours (2026-11-09): FFmpeg converted the composed RGB frames to YUV with its default BT.601 matrix, while players, Chromium among them, show HD video with BT.709, so saturated colours shifted: the synthetic source's yellow, 242,191,51 in the recording, played back from an export as 247,187,44, exactly the 601-to-709 mismatch. The export now converts with BT.709 in TV range and tags the stream so (`-vf scale=out_color_matrix=bt709:out_range=tv`, `-colorspace`, `-color_primaries`, `-color_trc`, `-color_range`), and the same places match the recording to the level; `tests/e2e/export-color.spec.ts` keeps it so.

- Recovery and soak gates (2026-11-09). `tests/e2e/export-recovery.spec.ts` kills the app's main process mid-render and starts it again on the same data: the job is reported failed with `export.interrupted`, never resumed, no file is left at the destination, and nothing of the app survives it (its renderer, GPU process, recorder host and FFmpeg all exit within half a second). `tests/e2e/soak.spec.ts`, run on demand with `USEE_SOAK=1`, exports a 30-second synthetic recording at 1080p30 and 4K30 and decodes each in full: on the development machine 1080p30 took 53.9 s (0.56 × real time, the app's peak memory 906 MB) and 4K30 197 s (0.15 ×, 1431 MB). The synthetic source is 1280 × 720, so these are upscales; real 1080p and 4K recordings still need measuring on the owner's machine.

Packaging and the runtime (2026-11-08):

- `npm run package` (`scripts/package-desktop.mjs`, electron-builder 26.18.0) builds a per-user NSIS installer holding only the bundled app, the recorder host and, once reviewed and trusted, the FFmpeg runtime (docs/release.md, "Packaging"). The packaged app starts from `win-unpacked/usee.exe` with `app.isPackaged`, finds its renderer and preload inside the ASAR and its host in resources, and without a reviewed runtime says export's encoder is not installed. It is unsigned: no certificate exists yet.
- Electron moved from 44.8.0 to 44.9.3 for GHSA-jr5w-w6x2-84p9 (compromised eMudhra intermediate certificates, high), which `npm audit` reported against the runtime the installer ships; the unit and end-to-end suites pass on it.

Open source (2026-11-18): the owner is publishing usee as free, open-source software under the MIT License. The FFmpeg review became the owner's release decision, [ADR-012](decisions/ADR-012-ffmpeg-release.md), and signing goes through the SignPath Foundation's programme for open-source projects after a first, unsigned release (docs/release.md, "Signing"). Before publishing, the feature list was rebuilt from public guides as [roadmap.md](roadmap.md), and the working title left the code. The repository went public at github.com/techuhat/usee on 2026-11-18, its history starting there, with the README, the contributing guide, the code of conduct, the security policy and the issue and pull request templates; CI's actions are pinned by commit and Dependabot proposes updates (docs/dependency-management.md).

Releases (2026-11-18): `.github/workflows/release.yml` builds each release on GitHub from a tag (docs/release.md). FFmpeg 9.0.2, still the newest 9.0 release, is built there from its pinned source under ADR-012, its manifest's SHA-256 becomes the trust anchor at build time, the installer ships that runtime, the export specs run against it, and a GitHub pre-release holds the installer, FFmpeg's source and `build.json`. v0.1.0 is the first. The release checks its runtime with the export worker's own commands (`tests/integration/ffmpeg-export.test.ts`) rather than the E2E export specs: without a GPU, export runs on the processor, and those specs, 23 s each on the development machine and 40 s with its renderer forced onto WARP, did not finish within four minutes each on GitHub's runner. That runtime check also found that when FFmpeg leaves before it has read every frame, as its first, GPU attempt does on a machine without a GPU encoder, the broken pipe became an uncaught exception in main; the process runner now hears it, and the software encoder's attempt follows. Remaining: sign through SignPath and publish update metadata; then run the soak gate on real 1080p and 4K recordings (the synthetic gates for cancellation, recovery and a long export pass). An installer built locally still ships no FFmpeg, as nothing anchors a local runtime; an unpackaged build exports with the `npm run build:ffmpeg` output. Phase 7 is not complete.

## Phase 8 — Optional expansion

Evaluate webcam/window/region capture, annotations, recording/edit presets, subtitles, audio processing, watermarks, cloud features, macOS support, and plugin model individually. The order is in [roadmap.md](roadmap.md). Each requires a design/ADR, privacy/security review, and a benchmark/maintenance owner before implementation.

Started on branch `phase-8-capture` at the owner's request (2026-11-16), while Phase 7's exit check waits on the FFmpeg review:

- Window and region capture have their design, privacy and security review, and benchmark and maintenance owner in [ADR-009](decisions/ADR-009-window-and-region-capture.md).
- Window capture: the record card chooses Screen or Window, lists the open windows with their sizes, and looks for them again on request. The host lists windows (recorder protocol 1.3, `listWindows`) and records one with WGC at the size it had at the start, the pointer normalized to the window as it moves; the journal and the project name the window by its ID, never its title. Tests record the synthetic window, `window-synthetic` (960 x 600), from the host and from the UI.
- Tracking (2026-11-17, at the owner's request for cursor tracking without delay and for the camera to move right in 2D and 3D): a frame's picture is older than its timestamp by the capture latency, so the host measures it per session and the editor reads the pointer, clicks and camera at the picture's moment, and the generated camera follows the pointer between the places it planned to look at, turning in 3D with it (ADR-010). On the owner's real screen the latency measured +3.5 to +7.5 ms for a display and -6.5 to -9.5 ms for a window, steady within each session. Most of the delay that showed was the smoothed cursor trailing into each stop: it now stays within a few pixels of the real pointer.
- Annotations (2026-11-17, ADR-011): words, an arrow or a box over the picture for a span of a clip, added with Annotate (T) at the playhead, shaped and coloured in the inspector and moved by handles over the picture; drawn by the same compositor in preview and export, under click effects and the cursor. Manifest v11.
- Region capture: the record card's Area choice opens the area picker, a transparent window of the app's own over the chosen screen, where the user drags out the area and records it (Enter, or "Record this area") or cancels (Escape, a right click). Main turns the rectangle into the display's pixels, keeps it inside the display, with even sides and at least 64 x 64, and the host copies that rectangle of every frame on the GPU before scaling and encoding. The journal and the project keep the rectangle. Tests crop the synthetic display from the host and through the picker in the UI, and a native test checks the crop pixel by pixel.

Each phase starts only after the previous phase's exit check passes and its work is reviewed. The project owner approved starting Phase 1 on 2026-10-17.
