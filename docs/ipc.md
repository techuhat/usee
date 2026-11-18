# IPC and process boundaries

## Trust boundaries

```text
Renderer (untrusted web content)
  ↓ fixed preload API
Preload (context-isolated bridge)
  ↓ allowlisted, schema-validated Electron IPC
Main process (application authority)
  ↓ authenticated, versioned local named pipe
Recorder host (native authority)
  ↓ fixed job manifest / progress protocol
FFmpeg worker
```

The renderer is not trusted with native authority, even though it ships with the application. It has `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, and a restrictive content-security policy. Production content is served from the privileged `app://renderer` scheme with the CSP as a response header; the loopback Vite dev server gets a development CSP. The foundation exposed only `window.desktop.getRuntimeInfo()`; Phase 1 added the recording and recovery methods, and Phase 2 the project methods below.

## Implementation

- Channels are declared once in `packages/contracts/src/ipc.ts` (`desktopInvokeChannels`, `desktopEventChannels`) with zod request and response schemas. Names follow `desktop.<area>.<verb-phrase>`.
- `apps/desktop/src/main/ipc/invoke-router.ts` registers handlers. Each call is checked in order: the sender frame's origin must be trusted, the request must match its schema, the handler runs, and its response must match its schema. Anything a handler throws becomes `ipc.handler-failed`; the cause is logged locally, never sent.
- `apps/desktop/src/preload/desktop-bridge.ts` builds the frozen `window.desktop` object. It validates every reply before the page sees it and resolves, never rejects, with a `Result`.

## Area picker (Phase 8)

`desktop.recording.choose-region` takes a display ID, opens the area picker over that display and replies when it closes: with the area in the display's pixels, or null when it was cancelled (ADR-009). The picker is another window of the app's own page (`#region-picker`), with the same preload, sandbox and content security policy; its only call is `desktop.recording.finish-region`, which carries the rectangle drawn in the picker's CSS pixels, or null. Main converts that to the display's pixels and keeps it inside the display; the area then reaches the recorder only as part of a `desktop.recording.start` request, whose schema bounds it and whose display the host checks it against.

## Projects (Phase 2)

The `desktop.project.*` channels list, open, close and edit the open project: `list`, `open`, `get`, `close`, `edit` (one `TimelineCommand`), `undo`, `redo`, `save` (a retry after a failed background save) and `get-waveform`, plus the `desktop.project.changed` event. They carry a `ProjectSnapshot` (`packages/contracts/src/project.ts`): the timeline and the assets, with no filesystem paths. The only path the renderer ever sends is a `projectPath` from the project list or a finished recording, and the repository opens it only if it resolves to a bundle directly inside the projects folder (`project.outside-projects-folder` otherwise).

Source media never crosses IPC. Each playable asset has a URL, `app://media/<token>/<asset id>`, served from managed project assets with HTTP range requests (`apps/desktop/src/main/project/project-media.ts`), which the export worker also fetches to decode a recording in order. An export can hold a separate leased token until its queue job is terminal, even if the project closes. Media responses allow CORS for the app's own renderer origins only (`Access-Control-Allow-Origin` echoes a trusted `Origin`), and renderer videos load with `crossorigin="anonymous"` so composition can read decoded frames. Export's explicit `desktop.export.submit-frame` capability sends one bounded `Uint8Array` of raw RGBA pixels, exactly the output's width × height × 4 bytes, at a time in response to a matching main-process request; it contains only the composed output frame, applies backpressure, and never accepts a path, command or arbitrary asset. Queue status is sanitized, and destination and verified source paths stay in main.

The project list carries each of the 50 newest projects' thumbnail inline as a JPEG data URL, and `saveProjectThumbnail` (`desktop.project.save-thumbnail`) keeps one for the open project: at most 120 000 bytes that start as a JPEG does. No path crosses either way.

Picture focus adds `desktop.project.get-picture-changes` and `desktop.project.save-picture-changes`: the renderer names a video asset of the open project, and sends what it found in its picture as a bounded list of normalized boxes (`packages/contracts/src/picture-changes.ts`); main writes it under the bundle's `derived/` by asset ID and plans the camera again. No path crosses either way.

## Settings

The `desktop.settings.*` channels read and change the user's settings: `get` returns the whole validated snapshot (`packages/contracts/src/settings.ts`), and `update` replaces the sections it names (`recording`, `newProjects`, `export`, `analysis`, `welcome`) and returns the result, which main validates whole before it saves it. No setting is a path or a device: the microphone is chosen for each recording, and the renderer cannot name a folder. `desktop.app.show-projects-folder` takes no input and opens the projects folder, which only main knows, in the system file manager.

## Contract rules

- Every public command has a stable name, input schema, output schema, error union, and protocol version.
- Renderer input is parsed at the main-process boundary. Main-to-renderer events are also schema checked before exposure.
- IPC handlers are short: they validate, dispatch a use case, and return a typed result. They do not embed recording, encoding, or filesystem behavior.
- Preload exports named methods, not `ipcRenderer`, `invoke`, `send`, or event-channel strings.
- Host protocol messages are length-limited, correlation-ID tagged, versioned, and authenticated using a per-launch secret passed through inherited handle/environment—not command-line text.
- Progress/meters use bounded event rates and coalesce rather than accumulating renderer work.
- Export frames use only the explicit, schema-validated one-frame IPC method and are bounded to 64 MiB; main has at most two frame requests outstanding per export. Source media and arbitrary files are never sent through IPC.

## Example capability surface

```ts
interface DesktopBridge {
  getRuntimeInfo(): Promise<Result<RuntimeInfo, AppError>>;
  // Future explicit methods:
  // startRecording(request): Promise<Result<RecordingSession, AppError>>;
  // openProject(request): Promise<Result<ProjectSnapshot, AppError>>;
  // submitExport(request): Promise<Result<ExportJob, AppError>>;
}
```

Future methods are added only after their application port, input/output schema, error model, permission story, and test coverage exist. There is no generic `execute`, `runFfmpeg`, `readFile`, or `openExternal` method.

## Error propagation

Errors crossing IPC are structured `AppError` values containing category, stable code, retryability, user-safe message key, correlation ID, and redacted diagnostic context. Native causes are logged locally but are not blindly serialized to the renderer. The renderer can show the safe message and a support reference.

## Versioning

Electron main/preload contracts use semantic compatibility rules. The recorder-host protocol has an explicit major/minor version and handshake. A shell only launches an engine whose major protocol version it supports. Update packages replace the shell, host, and FFmpeg manifest atomically; updates are deferred during recording or rendering.
