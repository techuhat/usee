# Recorder host protocol, version 1.3

Electron main controls the native recorder host (`native/recorder-host`) over one named pipe per host process. The canonical message schemas are in `packages/contracts/src/recorder-protocol.ts`; the C++ host is checked against them by `tests/integration/recorder-host.test.ts`, which parses every message and journal line the real host writes.

## Launch and authentication

Main starts `recorder-host.exe` with no command-line arguments and a minimal environment (`packages/adapter-recorder-host/src/launch-recorder-host.ts`):

| Variable                | Value                                                              |
| ----------------------- | ------------------------------------------------------------------ |
| `USEE_PIPE_NAME`        | `\\.\pipe\usee-recorder-<32 lowercase hex>`, random per launch     |
| `USEE_HOST_TOKEN`       | 64 lowercase hex characters (256 bits), random per launch          |
| `USEE_STAGING_ROOT`     | Absolute local directory; the only place the host writes           |
| `USEE_SYNTHETIC_SOURCE` | `1` to offer the synthetic test pattern and test tone (tests only) |

The host validates all of them, removes the token from its own environment, and creates the pipe:

- The DACL allows only the current user and SYSTEM.
- `PIPE_REJECT_REMOTE_CLIENTS`, and `FILE_FLAG_FIRST_PIPE_INSTANCE` so creation fails if another process already owns the name.
- One instance, one client per host lifetime. The client must also be the host's parent process.

The first request must be `hello` with the token, compared in constant time. Anything else, a wrong token, or an unsupported major version closes the connection. When the client disconnects, the host finalizes any active session and exits, so no recorded segment is lost.

## Framing

Each message is a 4-byte little-endian payload length followed by that many bytes of UTF-8 JSON. Lengths of 0 or above 65,536 bytes are protocol violations and close the connection. Frames may be split or merged across reads.

## Messages

```text
client → host   { "kind": "request",  "id": "<opaque>", "method": "<name>", "params": { … } }
host → client   { "kind": "response", "id": "<same>", "ok": true,  "result": { … } }
host → client   { "kind": "response", "id": "<same>", "ok": false, "error": HostError }
host → client   { "kind": "event", "name": "<name>", "data": { … } }
```

`HostError` is `{ category, code, retryable, detail? }`. `category` is one of `capture`, `audio`, `encoding`, `storage` or `native`; `code` is `<category>.<kebab-case-reason>`; `detail` is support-safe text such as an HRESULT, never a path or device name. Main maps it to an `AppError` with `hostErrorToAppError`.

## Methods

| Method            | Params                                                                                                                                                                                                                                                                                                                                                   | Result                                                                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hello`           | `protocolMajor`, `protocolMinor`, `token`                                                                                                                                                                                                                                                                                                                | `protocolMajor`, `protocolMinor`, `hostVersion`, `capabilities { displayCapture, microphone, syntheticSource }`                                                   |
| `listDisplays`    | none                                                                                                                                                                                                                                                                                                                                                     | `displays[] { id, name, x, y, width, height, isPrimary, refreshRateHz }`                                                                                          |
| `listWindows`     | none (since 1.3)                                                                                                                                                                                                                                                                                                                                         | `windows[] { id, title, width, height }`, at most 64, front first                                                                                                 |
| `listAudioInputs` | none                                                                                                                                                                                                                                                                                                                                                     | `inputs[] { id, name, isDefault }`                                                                                                                                |
| `startSession`    | `sessionId`, `sourceKind` (since 1.3: `display` when absent, `window` or `region`), `displayId` for a display or a region, `windowId` for a window, `region { x, y, width, height }` for a region, `frameRateNumerator`, `frameRateDenominator`, `includeCursor`, `trackPointer` (since 1.2), `segmentDurationMs` (2,000–60,000), `audioInputId` or null | `sessionId`, `video { width, height, encoderName, hardwareEncoder }`, `audio { sampleRateHz, channels }` or null                                                  |
| `stopSession`     | `sessionId`                                                                                                                                                                                                                                                                                                                                              | `sessionId`, `durationUs`, `framesCaptured`, `framesEncoded`, `framesDropped`, `audioDiscontinuities`, `audioFailed`, `segments[]`, `failure` (HostError or null) |
| `mergeSession`    | `sessionId`, `verifyHashes` (since 1.1)                                                                                                                                                                                                                                                                                                                  | `sessionId`, `fileName`, `durationUs`, `bytes`, `sha256`, `videoFrames`, `hasAudio`, `segmentsMerged`, `segmentsSkipped`, `waveform` or null                      |
| `shutdown`        | none                                                                                                                                                                                                                                                                                                                                                     | empty; the host finalizes any session and exits                                                                                                                   |

Display and audio IDs (`display-<8 hex>`, `audio-<8 hex>`) are hashes of the OS device names, so names and endpoint IDs never cross the pipe. A display ID stays valid while the display topology is unchanged. With `USEE_SYNTHETIC_SOURCE=1` the host also lists the display `synthetic-0`, a 1280 x 720 checkerboard with a box that moves a step every 250 ms after capture starts, and the audio input `synthetic-audio`, a 440 Hz tone for the first half of every second.

Window IDs (`window-<16 hex>`, since 1.3) come from the window's handle and stay valid while it is open. `listWindows` offers the windows a user would choose (ADR-009): top-level, visible, not minimized, not cloaked by the shell, titled, not tool windows, and not of the host's parent process, usee itself. A title crosses the pipe only in this reply, for the picker; the journal and the log name a window by its ID. Titles are cut to 128 UTF-16 units, with any lone surrogate replaced, so a full list fits one frame. `startSession` finds the window again by its ID and refuses one that is no longer listed with `capture.source-unavailable`. The recording keeps the size the window had when it started; a window that closes while it is recorded fails the session with `capture.source-closed`, and what was recorded until then is kept. With the synthetic source the host lists `window-synthetic` first: the synthetic pattern at 960 x 600, recorded as a window session.

A region (since 1.3) is a rectangle of one display in its pixels, at least 64 x 64 and wholly inside the display, which the host checks against the display's size (`native.invalid-params` otherwise). The display is captured as usual, and each frame's rectangle is copied on the GPU before it is scaled and encoded, so the recording has the region's size. Main sends even sides, so H.264 encodes the region unscaled; on the development machine the GPU's encoder refused regions as small as 128 x 96 and the session used Windows' software encoder, as it does for any size the GPU refuses. The pointer is normalized to the region, and the synthetic pointer too when a region of the synthetic display is recorded.

### Pointer stream

With `trackPointer` the host writes `pointer.ndjson` in the session directory: everything the editor needs to draw the cursor itself, and nothing more. It never reads the keyboard. The first line is a header:

```json
{
  "format": "usee.pointer",
  "version": 1,
  "sessionId": "…",
  "coordinateSpace": "capture",
  "display": { "width": 3840, "height": 2160, "dpiScale": 2.0 }
}
```

Hosts before 2026-11-18, under the working title, wrote `screen-studio.pointer`, which readers still accept.

Each further line is one event, at session time in microseconds: `move` (`x`, `y`), `down` and `up` (`button`: `left`, `right`, `middle`, `x1`, `x2`, plus `x`, `y`), `shape` (a standard cursor kind such as `arrow`, `text` or `pointer`; a cursor an application drew itself is `arrow`) and `visibility` (`visible`). Positions are normalized to what is captured, 0 to 1 across its width and height, and may fall outside it: the display, or a window's extended frame bounds, read again at every poll because the window may move. For a window, the header's `display` is the captured size and the scale of the display the window is on. Position and shape are polled at 120 Hz and recorded when they change. Buttons come from raw mouse input on a message-only window, so they arrive while another application has focus. Lines are flushed at least every 500 ms, so a crash loses at most that much; a reader skips a line cut off by one. With the synthetic display, a synthetic pointer circles the frame every 4 seconds of the session clock and clicks once a second instead of reading the real mouse, so it is at the same place at the same moment of every recording.

The journal's `session-started` record names the file (`pointer: {"fileName":"pointer.ndjson"}`, or null). The project importer moves it to `metadata/interactions/<session>.pointer.ndjson` as the session's `event` asset.

### Merging a session

`mergeSession` joins a finished session's segments into one MP4, `recording.mp4`, holding the H.264 video and, when audio was recorded, the AAC audio. It remuxes without re-encoding, interleaving the two streams by time. The host takes the segment list from its own journal rather than the request, so the request stays small however long the recording is; only `segment-closed` records whose file name is the host's own `video-NNNNN.mp4`/`audio-NNNNN.m4a` pattern are used. Segments whose file no longer matches its record (size, and SHA-256 when `verifyHashes` is true, as recovery asks) are skipped and counted in `segmentsSkipped`.

The merge writes `recording.partial.mp4` and renames it once finalized, then decodes the audio into `waveform.json` (see [project-format.md](project-format.md), "Derived artifacts"), again through a `.partial` file. A waveform failure is logged and returns `waveform: null`; the merge itself still succeeds. It fails, and main imports the segments one clip each instead, with:

- `capture.session-active`: the session is still recording.
- `storage.session-not-found`: no journal for that session.
- `storage.nothing-to-merge`: no usable video segment.
- `encoding.merge-incompatible`: segments disagree on the codec configuration, as after a mid-session switch to the software encoder.
- `encoding.merge-gap`, `encoding.merge-overlap`: audio segments that do not tile, or video segments that overlap.
- `storage.disk-full`, `storage.merge-failed`, `storage.segment-unreadable`: reading or writing failed.

The host's request loop is busy while it merges; main allows a merge up to 30 minutes.

## Events

| Event                   | Data                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `session.state`         | `sessionId`, `state` (`recording`, `finalizing`, `completed`, `failed`), `error` or null                                           |
| `session.segment`       | `sessionId` and one segment: `stream`, `index`, `fileName`, `startUs`, `durationUs`, `bytes`, `sha256`, `frames`                   |
| `session.metrics`       | `sessionId`, `elapsedUs`, `framesCaptured`, `framesEncoded`, `framesDropped`, `audioFrames`, `audioDiscontinuities` (every 500 ms) |
| `session.stream-failed` | `sessionId`, `stream`, `error`; the session continues without that stream                                                          |

Clients ignore event names they do not know, so a minor version can add events.

## Session directory and journal

A session writes only to `<staging root>/<sessionId>/`:

```text
journal.ndjson       one record per line, flushed to disk before the host continues
video-00000.mp4      H.264 segments; each starts with a keyframe and plays on its own
audio-00000.m4a      AAC segments (when audio is recorded); see below
recording.mp4        written by mergeSession, with waveform.json
pointer.ndjson       the pointer stream (with trackPointer)
```

Journal records: `session-started` (what was recorded, as `sourceKind`, the display's or window's ID and a region's rectangle since 1.3; video format, encoder, audio format), `segment-closed` (the segment fields above), `stream-failed`, `session-failed`, and `session-finalized`, which since 1.3 carries `captureLatencyUs`: the median, over the new pictures encoded, of a picture's frame time minus the time Windows gives it (`SystemRelativeTime`), negative for a picture shown after its frame time, in whole milliseconds plus 500 µs (ADR-010); absent when no picture was encoded or the median is beyond 250 ms either way, which is logged as `session.capture-latency.implausible`. The host also logs the latency's spread as `session.capture-latency` (numbers only). After a crash, the `segment-closed` records whose files still match their size and SHA-256 are exactly the recoverable recording.

All times are integer microseconds from the session epoch, a QueryPerformanceCounter reading taken when recording starts. Segment start and end are rounded once each and the duration is their difference, so consecutive segments tile the clock with no gap or overlap.

Audio comes from one AAC encoder for the whole session, starting at the epoch (silence covers the moment before the first packet). Each 1024-sample AAC frame goes to the segment its first sample falls in, so audio segments hold whole frames, end within one frame (21.3 ms) of the video boundary, and tile exactly. Joining them again is therefore exact: one encoder per segment would have added a priming gap at every boundary.

## Versioning

The major version changes for any incompatible change to framing, a method, or a required field. The minor version may add optional fields, methods or events. Version 1.1 added `mergeSession` and the synthetic audio input; 1.2 added `trackPointer` and the pointer stream; 1.3 added `listWindows`, window and region sessions (`sourceKind`, `windowId`, `region`) and the session's capture latency (`captureLatencyUs`). A shell launches only a host whose major version it supports, and updates replace shell and host together (docs/ipc.md, "Versioning").
