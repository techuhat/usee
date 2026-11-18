# ADR-009: Window and region capture

- Status: Accepted
- Date: 2026-11-16
- Owner: the project owner, who approved building it on 2026-11-16; maintained with the recorder host.

## Context

usee records one whole display. Phase 8 lists window and region capture, and each Phase 8 feature needs a design, a privacy and security review, and a benchmark and maintenance owner before it is built (docs/development-phases.md). The architecture already chose the backends: Windows Graphics Capture (WGC) for displays and windows, and a region as a GPU crop over an approved display capture, not an OS primitive (docs/recording-pipeline.md, docs/architecture.md). The domain types a recording session's sources as display, window, region or webcam (`packages/domain/src/recording.ts`), and the project format already accepts window and region sources, so no manifest version changes.

## Decision

### Sources

A recording has one picture source:

- **Display**: as today.
- **Window**: one top-level window, captured with WGC's `CreateForWindow`. The picture is the window as Windows composes it, its frame included.
- **Region**: a rectangle of one display, in that display's pixels: the display is captured with WGC as today and each frame's rectangle is copied on the GPU before scaling and encoding. The rectangle is drawn by the user on an overlay over that display; it is at least 64 x 64 pixels, and main gives it even sides so H.264 encodes it unscaled.

The output size is fixed when a recording starts, from the window's or the region's size (scaled down to the encoder's limit, as a display is). A window resized while it is recorded keeps that size: the part that overlaps is copied, as a display that changes resolution is today. A window that closes ends the recording with `capture.source-closed`; what was recorded is kept.

### The window list

The host's new `listWindows` method lists the windows a user would choose: top-level, visible, not minimized, not cloaked by the shell, titled, not tool windows, and not usee's own (the host's parent process). The list holds at most 64 windows, front first, and cuts titles to 128 UTF-16 units (replacing any lone surrogate), so it fits one protocol frame. Each window has an opaque ID, `window-<16 hex>`, derived from its handle; the host finds the window again by that ID when a recording starts and refuses one that has closed, hidden or minimized since (`capture.source-unavailable`). Its title and size go to the renderer only so the user can choose it.

### The pointer

The pointer is normalized to what is recorded: a display's bounds as today, a window's extended frame bounds read again at every poll (the window may move), a region's rectangle. Outside it, coordinates fall outside 0-1, and the editor draws and focuses only inside.

### Protocol and contracts

Recorder protocol 1.3 adds `listWindows` and, to `startSession`, an optional `sourceKind` (`display` when absent, `window` or `region`), `windowId` for a window and `region` for a region; `displayId` is required for a display or a region. The journal's `session-started` record names the kind and the window's ID. `StartRecordingRequest` names its source as `{ kind: 'display', displayId }`, `{ kind: 'window', windowId }` or `{ kind: 'region', displayId, region }`, and the project's recording session records it (`kind: 'window'` with the window's ID, or `kind: 'region'` with the rectangle).

### Tests

Automated tests never capture the real screen. With the synthetic source on, the host also lists a synthetic window, `window-synthetic`, which renders the synthetic pattern at 960 x 600 through the window path, and a region of the synthetic display crops the synthetic frames.

## Privacy and security review

- A window or region is recorded only after an explicit choice and Start, and the record card shows what will be recorded first (docs/security.md, "Permissions and user intent").
- Windows' capture consent and border policy are respected: WGC draws its border around what is captured, and the host never turns it off or captures a window Windows refuses (protected content, a window of an elevated app it cannot capture), which fails with `capture.source-unavailable`.
- Window titles can name documents and sites. They cross the pipe and IPC only to the picker; the journal, the manifest and the logs name a window by its opaque ID, never its title.
- The region overlay is another of the app's windows with the same sandbox, context isolation and content security policy; it returns only a rectangle, which main checks lies inside the chosen display before the host sees it.
- The pointer is still the pointer only: no keystrokes, no window titles.

## Benchmark and maintenance

Window capture uses the same WGC frame path as a display, and a region adds one GPU copy of the rectangle, so neither should cost more than recording the whole display; the synthetic window and region run through the end-to-end suite on the development machine, and the owner measures a real window and region before release. The recorder host's maintainer owns both, with the display capture they extend.

## Consequences

Recording a single app or part of a screen no longer needs a crop in the editor, and the recording is smaller. A resized window is cropped or padded rather than rescaled, and WGC cannot capture a minimized window; both are documented limits. The source list now changes with what is open, so the record card can refresh it.
