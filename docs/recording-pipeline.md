# Recording pipeline

## Scope and ownership

The recorder host is a local Windows executable launched and supervised by Electron main. It owns native device handles and all high-frequency data. It is restartable; Electron holds a durable session journal and turns unexpected host termination into a typed recovery outcome.

```text
Capture configuration
  → source/device preflight
  → staged recording session + journal
  → common session clock
  → WGC/D3D11 video ─┐
  → WASAPI mic ─────┼─► bounded, independently back-pressured pipelines
  → WASAPI loopback ┤      → Media Foundation live encode
  → pointer/click ──┘      → media/event segments + metadata
  → finalization/validation → import into project
```

## Backend contracts

The native implementation will fulfill these conceptual ports:

- `CaptureBackend`: enumerate display/window candidates; open/stop capture; report pixel format, HDR/color-space, resize, and device-loss events.
- `AudioBackend`: enumerate endpoints; open microphone or WASAPI loopback streams; emit clocked packets and device-change events.
- `InputBackend`: start/stop pointer and click tracking; output session-relative events in a declared coordinate space.
- `LiveEncoder`: accept GPU/video and audio inputs; write bounded segment files; report codec, throughput, and dropped-frame metrics.
- `SessionClock`: map QPC, audio-frame, and input timestamp sources to session-relative microseconds.

Windows Graphics Capture is the primary display/window capture backend. Region capture is implemented as a GPU crop over an approved display capture rather than a distinct OS capture primitive. Desktop Duplication remains an explicitly measured fallback only. WGC source selection must respect Windows consent/border behavior; it cannot silently bypass system policy.

For audio, microphone capture and system playback use separate WASAPI streams. WASAPI loopback can capture the audio played by a render endpoint without relying on vendor-specific “Stereo Mix” devices. Protected content can be unavailable and is surfaced as a clear product limitation, not treated as an application failure. [Microsoft's loopback documentation](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording) describes these constraints.

## Lifecycle

```text
Idle
  → Preparing (validate config, reserve staging, preflight devices)
  → Ready (all selected paths acknowledge)
  → Recording (clocked segment writers active)
  → Paused (if each selected backend supports a synchronized pause)
  → Stopping (stop accepting input, drain bounded queues)
  → Finalizing (close segments, index, hash, validate)
  → Completed | Failed | Recovered
```

Every transition is idempotent and journaled. UI receives only a projection of this state machine. `stop` has a time-bounded drain phase and preserves partial recoverable segments if finalization fails.

## Timestamping and coordinate spaces

- Persist integer microseconds relative to a session epoch, not floating-point wall-clock values.
- Record the capture topology at start: display dimensions, DPI scale, rotation, origin, color/HDR facts, and coordinate-space version.
- Cursor positions use normalized source coordinates plus their topology version, so later rendering can map events correctly after crop/scale/rotation.
- Store raw events and raw asset references immutably. Smoothed cursor paths, click bursts, and focus candidates are derivatives.
- A frame is stamped with its tick on the frame grid, but its picture is older: Windows composed it a capture latency earlier. The host measures that latency per session, as the median over new pictures of frame time minus composition time, and journals it; the editor reads the pointer, clicks and camera that much earlier, so they meet the picture (ADR-010).

## Live encoding and durability

Media Foundation is the preferred live-recording encoder abstraction because it keeps the hot path close to D3D11 and exposes hardware encoders where supported. Encoder choice is capability-driven and records the actual codec/driver path used. A software fallback is mandatory.

The recorder writes short independently valid segments and a journal. It does not retain a full recording in RAM or pipe raw frames through Electron. On finalization, the host creates an asset manifest with checksums and duration validation; only then does the project manager import the session.

## Error and recovery contract

| Condition                             | User-visible outcome                                               | Engineering action                                              |
| ------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------- |
| Unsupported/blocked source            | Actionable `CaptureError` with remediation                         | Keep project open; never start partial hidden capture           |
| Microphone unavailable                | Choice to retry, select another device, or record video without it | Persist exact selected-device failure code                      |
| System-audio capability/device change | Clear stream status and configuration choice                       | Reinitialize only after controlled clock boundary               |
| GPU device loss                       | Recording safely stops or resumes at a segment boundary            | Preserve journal/previous segments; emit diagnostics            |
| Encoder overload                      | Quality/drop policy shown in diagnostics                           | Apply configured bounded policy, never unbounded memory growth  |
| Host crash                            | Recoverable session prompt                                         | Electron scans journal and imports valid segments after consent |

## Implementation status

The Phase 1 vertical slice implements this contract for one display and an optional microphone; Phase 2 joins each finished recording into one file for the editor; Phase 8 adds one window or a region of a display as the source (ADR-009). The wire protocol and journal are specified in [recorder-host-protocol.md](recorder-host-protocol.md).

| Contract item                              | Status                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Display capture (WGC/D3D11)                | Implemented; 30 or 60 fps constant frame rate; larger displays are scaled on the GPU to fit 1920×1080                          |
| Window capture (WGC)                       | Implemented (Phase 8, ADR-009): one window, at the size it had when recording started; the pointer follows it                  |
| Region crop                                | Implemented (Phase 8, ADR-009): a rectangle of one display, copied on the GPU from each frame; the pointer is normalized to it |
| Microphone (WASAPI)                        | Implemented; 48 kHz stereo AAC from one encoder per session, silence-padded across device gaps                                 |
| System-audio loopback                      | Not yet                                                                                                                        |
| Pointer and click tracking                 | Implemented (Phase 3): position, buttons and cursor shape at 120 Hz, never keystrokes                                          |
| Lifecycle                                  | Idle → Preparing → Recording → Finalizing → Completed / Failed; no pause yet                                                   |
| Live encode                                | H.264 through Media Foundation; GPU input with a software fallback                                                             |
| Segments and journal                       | 10-second segments; journal flushed per record; SHA-256 per segment                                                            |
| Finalization                               | Segments are remuxed into one MP4 (video and audio) plus a waveform; if that fails, one clip each                              |
| Unsupported source, microphone unavailable | Start fails with a typed, retryable error; nothing is captured                                                                 |
| Microphone lost mid-session                | Video continues; the UI shows "Microphone stopped"                                                                             |
| Source closed mid-session                  | Recording stops; what was recorded is imported and the error shown                                                             |
| Host crash                                 | Session stays staged; Recover merges the segments whose hashes still match, or Discard                                         |
| Encoder overload                           | Late ticks are dropped and counted; memory stays bounded                                                                       |
