# Architecture

## Decision summary

usee is a Windows-first desktop recorder and video-enhancement product. Its foundation uses an **Electron shell**, a **React + TypeScript renderer**, and a separately restartable **C++20/WinRT recorder host** for the native media hot path. The owner named it usee on 2026-10-19; its packages are scoped `@usee/`. It reuses no other product's code, assets or branding.

Electron is the desktop control plane and preview host, not the high-throughput capture pipeline. The recorder host will own Windows Graphics Capture (WGC), D3D11 surfaces, WASAPI audio, input capture, and live recording. It communicates with Electron through a versioned, authenticated local named-pipe protocol. FFmpeg is a controlled worker behind the media adapter; neither the renderer nor arbitrary UI input can launch it.

Windows Graphics Capture supplies display/window frames backed by Direct3D and exposes QPC-based timestamps. Microsoft advises keeping work triggered by frame arrival off the UI thread. WGC and WASAPI therefore belong in the native host, not in a React component or Electron renderer. [Windows screen capture guidance](https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture) and [WASAPI loopback recording](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording) inform this split.

## Framework decision

| Option                        | Strengths                                                                                                                                           | Principal cost                                                                                                         | Decision                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Electron + React + TypeScript | Mature TypeScript/Chromium ecosystem, rich WebGL/WebCodecs preview path, reliable desktop lifecycle and packaging, excellent developer productivity | Higher shell-memory and bundle footprint than a system-webview shell                                                   | **Selected**                                                            |
| Tauri 2 + React + Rust        | Lower baseline shell footprint, strong Rust security model, excellent native boundary                                                               | Requires a second application/runtime language and a bespoke Rust graphics/media stack alongside the TypeScript editor | Revisit only if measured Electron baseline fails the performance budget |
| C#/.NET + WinUI 3             | First-class Windows/Media Foundation integration                                                                                                    | Windows-centric team and UI stack; weaker TypeScript continuity and more expensive macOS path                          | Not selected                                                            |
| Qt/C++                        | Powerful cross-platform native UI and media integration                                                                                             | High UI-development and language cost for a TypeScript-first product                                                   | Not selected                                                            |

The memory trade-off is intentional and measurable. Electron's renderer is constrained to UI, proxy playback, and preview composition; recording, encoding, proxy creation, and export never run in it. The release gate includes idle-memory, 1080p/60, 4K/30, and long-session soak benchmarks. A future framework replacement is not planned; the native host and domain boundaries make a comparative spike possible without contaminating product logic.

## Language strategy

| Layer                                                               | Language           | Reason                                                                      |
| ------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------- |
| Renderer UI, editor presentation, local view state                  | TypeScript + React | Strong typed UI ecosystem and productive interactive editor development     |
| Electron main process, preload, IPC client, application composition | TypeScript         | Keeps all non-media desktop code in one language                            |
| Shared domain, application ports, persisted-project DTOs            | TypeScript         | Strict types, pure and easily unit tested                                   |
| Windows capture, audio, input, live encode orchestration            | C++20 + C++/WinRT  | Direct, efficient access to WGC, D3D11, WASAPI, Media Foundation, and Win32 |
| GPU-only effect kernels, if benchmarks justify them                 | HLSL               | Native shader language; only introduced behind a compositor interface       |
| Offline probe/transcode/compose/export                              | FFmpeg executable  | Broad codec/container support under a controlled adapter                    |

C++ is confined to the `native/recorder-host` boundary. It must not expose Windows types beyond its protocol, and no Node native addon is used: a codec or GPU crash must not take down Electron's main process.

## Layered design

```text
┌────────────────────────────────────────────────────────────────────┐
│ Presentation: React views, presentational components, scoped stores │
└───────────────────────────────┬────────────────────────────────────┘
                                │ DesktopBridge (narrow, typed)
┌───────────────────────────────▼────────────────────────────────────┐
│ Application: commands, use cases, ports, undoable project actions   │
└───────────────────────────────┬────────────────────────────────────┘
                                │
┌───────────────────────────────▼────────────────────────────────────┐
│ Domain: project, timeline, effects, camera, interaction semantics   │
└───────────────────────────────┬────────────────────────────────────┘
                                │
┌───────────────────────────────▼────────────────────────────────────┐
│ Infrastructure: project FS, logger, FFmpeg adapter, updater, cache  │
└───────────────────────────────┬────────────────────────────────────┘
                                │ versioned local RPC / process events
┌───────────────────────────────▼────────────────────────────────────┐
│ Native media: WGC/D3D11, WASAPI, input, Media Foundation, GPU work  │
└────────────────────────────────────────────────────────────────────┘
```

The dependency direction is inward. Domain is pure. Application can depend on domain. Adapters implement application ports and can depend on contracts/domain. Composition roots are the only locations permitted to instantiate concrete adapters.

## Process topology

```text
Untrusted renderer
  │  window.desktop (fixed capability surface)
  ▼
Electron preload ── validated invoke/event API ──► Electron main
                                                    │
                          project/settings/logs ◄───┼───► local filesystem
                                                    │
                                   versioned named pipe
                                                    ▼
                                    Recorder host (restartable native process)
                                    ├─ WGC/D3D11 capture + region crop
                                    ├─ WASAPI microphone + system loopback
                                    ├─ input capture + timestamping
                                    ├─ Media Foundation live encoding
                                    └─ bounded media/event segment writers
                                                    │
                                        manifest-only FFmpeg job
                                                    ▼
                                  FFmpeg worker: probe/proxy/export
```

Only control commands, status, diagnostics, and small preview metadata cross IPC. Raw video frames, PCM streams, and unbounded pointer samples never cross Electron IPC or the named pipe.

## Non-negotiable architecture rules

- React never imports Electron, Node, FFmpeg, or Windows APIs.
- The renderer receives no generic IPC invoke/send, filesystem, shell, or child-process API.
- Electron's `desktopCapturer` may be used only for an early source-picker fallback; it is not the production recording data path. See the [Electron API](https://www.electronjs.org/docs/latest/api/desktop-capturer).
- Native code owns capture device loss, clocking, and bounded live buffers; UI state is observational only.
- FFmpeg receives a validated render manifest and approved preset, never a UI-supplied command string or filter graph.
- Project changes are semantic commands. Undo/redo and persisted project truth belong in application/project services, never a global React store.
- Derived artifacts (proxies, waveforms, cursor paths, analysis) are disposable and reproducible from immutable source data.

## State ownership

| State                                      | Owner                                   | Notes                                                    |
| ------------------------------------------ | --------------------------------------- | -------------------------------------------------------- |
| Project, timeline, command history         | Project session service in main process | Canonical, persisted, undoable                           |
| Recording and render job lifecycle         | Application service                     | Main process stores a projection for UI subscribers      |
| Capture devices, encoder buffers, clocks   | Native recorder host                    | Never mirrored as mutable renderer state                 |
| UI layout, selection, hover, drag previews | Scoped renderer stores/component state  | Ephemeral; semantic commit happens on gesture completion |
| Settings and feature flags                 | Versioned settings service              | Persisted separately from projects                       |

Use separate, small Zustand stores for application shell, recording projection, editor interaction, playback view, and settings when implementation begins. Zustand is deliberately not introduced into this foundation until an actual renderer state owner exists.

## Extensibility seams

The first implementation targets Windows, but platform contracts hide all OS types. A future macOS recorder host maps the same protocol to ScreenCaptureKit/AVFoundation; Linux remains a separate feasibility decision. Webcam, annotations, templates, cloud sync, AI analysis, subtitles, and collaboration extend ports, effect schemas, and background jobs—they do not add logic to the renderer's root component.

See [module boundaries](module-boundaries.md), [IPC](ipc.md), [recording pipeline](recording-pipeline.md), and the ADRs in [decisions](decisions/).
