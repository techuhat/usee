# Native recorder host

The independently restartable C++20/WinRT process that owns capture, audio and live encoding. Electron main launches and supervises it; nothing here knows about projects or UI.

## Responsibilities

Implemented in Phase 1:

- Windows Graphics Capture of one display through D3D11, at a constant 30 or 60 fps.
- WASAPI microphone capture on the same QPC session clock.
- H.264 (Media Foundation, hardware with a software fallback) and AAC in self-contained segments.
- A journal flushed per record, and segments hashed with SHA-256, for crash recovery.
- Bounded memory under load: one buffered frame and a fixed GPU texture pool; late ticks are dropped and counted.
- A synthetic test-pattern source, so automated tests never capture the real screen.

Planned: window capture and GPU region crop, system-audio loopback, pointer and click tracking, synchronized pause.

## Forbidden responsibilities

- React/UI state, project semantics, undo/redo, persistence policy, user settings, and arbitrary FFmpeg command building.
- Sending raw frame/PCM data to Electron IPC.
- Loading plugins/DLLs or executables from user-provided project paths.

## Protocol

See [docs/recorder-host-protocol.md](../../docs/recorder-host-protocol.md). The canonical schemas are in `packages/contracts/src/recorder-protocol.ts`; `tests/integration/recorder-host.test.ts` runs the real host and validates every message and journal line it writes against them.

## Layout

```text
src/main.cpp, host_server.*   process entry, request dispatch, events
src/ipc/                      named-pipe server (DACL, first instance, overlapped I/O)
src/protocol/                 framing, JSON helpers, message envelopes
src/capture/                  D3D11 device, display enumeration, WGC capture, synthetic source
src/audio/                    WASAPI microphone capture and endpoint enumeration
src/encode/                   H.264 and AAC segment writers, GPU sample pool
src/session/                  recording session, frame store, journal, media clock, worker queue
src/util/                     errors, launch configuration, logging, SHA-256, UTF-8
tests/                        unit tests (no third-party framework)
```

## Build and test

Requires Visual Studio Build Tools 2019 16.11 or newer with the x64 C++ tools, and Windows SDK 10.0.22000 or newer.

```sh
npm run build:native             # Release build plus unit tests
node scripts/build-native.mjs --debug --no-tests
```

The script finds Visual Studio with `vswhere`, enters its developer environment, and uses the CMake and Ninja bundled with it. The executable is `build/release/recorder-host.exe`, built with the static CRT and `/W4 /WX`. With the host built, `npm test` also runs the integration tests that drive it.
