# ADR-003: Use Windows-native capture/audio with Media Foundation live encoding

- Status: Accepted
- Date: 2026-09-18

## Context

Production screen recording needs display/window/region capture, microphone/system audio, timestamping, device recovery, and performance at high resolutions without browser/IPC copies.

## Decision

Use Windows Graphics Capture plus D3D11 for display/window sources, GPU crop for regions, WASAPI for microphone and system loopback, QPC-backed session time, and Media Foundation behind a `LiveEncoder` interface. Keep Desktop Duplication as a measured fallback only.

## Consequences

The hot path is native and GPU-aware. Platform types remain confined to `native/recorder-host`; application contracts use platform-neutral DTOs. Encoder selection is runtime-capability driven with software fallback. WGC consent/border policy and protected-content limitations are product requirements, not hidden implementation details.
