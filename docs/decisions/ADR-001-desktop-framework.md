# ADR-001: Use Electron as the desktop shell

- Status: Accepted
- Date: 2026-09-18

## Context

The product needs a Windows-first, TypeScript-friendly high-performance editor and a future cross-platform route. It also needs reliable native capture/audio/media integration and a secure IPC boundary.

## Decision

Use Electron with React and TypeScript for the shell, renderer, main process, and preload. Keep capture/media outside Electron in a separate native host.

## Consequences

Electron supplies a mature TypeScript and Chromium preview ecosystem, package/runtime tooling, and a predictable process model. Its baseline memory and package footprint are higher than Tauri's system-webview approach; we accept this only with strict process separation and measurable performance gates. Tauri remains a documented alternative, not a second active architecture.

Electron's `desktopCapturer` is not the production recording engine; it can be a temporary picker/fallback only. The selected shell receives no raw media frames.
