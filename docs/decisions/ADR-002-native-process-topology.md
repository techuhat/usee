# ADR-002: Isolate native media in a restartable recorder host

- Status: Accepted
- Date: 2026-09-18

## Context

Capture, GPU work, codecs, and device drivers can fail independently of editor UI. A Node native addon would share Electron main-process fate and expose ABI/toolchain coupling.

## Decision

Implement a local C++20/WinRT recorder-host executable. Electron main supervises it through an authenticated, versioned named-pipe protocol. FFmpeg runs behind a host/main-controlled adapter using fixed manifests.

## Consequences

The native host can be restarted, tested, versioned, and crash-contained independently. It adds protocol/versioning and a C++ build pipeline, which are preferable to sharing a crash domain. Raw media remains in native/GPU/disk paths; only bounded control/progress data reaches Electron.
