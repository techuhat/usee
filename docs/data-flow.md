# Data flow

## Recording-to-export lifecycle

```text
User starts recording
  → renderer submits a validated configuration command
  → main process creates staged session + recovery journal
  → recorder host validates devices and reports ready
  → shared monotonic session clock starts
  → WGC frames + WASAPI chunks + input events are timestamped
  → bounded segment writers persist raw media and metadata
  → stop finalizes, hashes, and validates staged assets
  → project manager imports assets into a new/updated project
  → background jobs generate proxies, waveforms, cursor derivations
  → focus intelligence proposes a generated camera track
  → timeline resolves effects + manual edits into a render plan
  → preview uses proxy/render-plan path
  → export snapshots project, renders, validates, atomically publishes
```

## Execution classification

| Work                                                                 | Location                          | Execution rule                                                           |
| -------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------ |
| Capture, clocking, input, audio, live encode, segment writes         | Native recorder host              | Real time; bounded queues, no renderer/main-thread dependency            |
| Project command validation, persistence coordination, job scheduling | Electron main                     | Async application work; short IPC handlers only                          |
| Proxy/waveform/cursor derivation, auto-zoom analysis, migration      | Background worker/native host     | Cancellable, checkpointed, lowest priority while recording               |
| GPU frame surfaces, compositing, hardware decode/encode              | Native host / approved GPU worker | Keep surfaces GPU-resident where possible; capability probe and fallback |
| Timeline manipulation, selection, dialogs, optimistic drag preview   | Renderer                          | UI-only; commit semantic command at the end of a gesture                 |
| FFmpeg command execution                                             | Controlled FFmpeg adapter         | Manifest-driven background process; never renderer controlled            |

## Backpressure and recovery

- Video, audio, and event paths use separate bounded queues with explicit drop/degrade policies and telemetry.
- A shared monotonic session clock maps WGC QPC timestamps, WASAPI samples, and input events; wall-clock time is metadata only.
- Recording writes short durable segments plus a journal. A crash can at most lose the active segment, not an entire long session.
- Assets are staged, verified, and atomically imported. Project manifests use temp-write, flush, rename, and a recovery checkpoint.
- Background derivations are content-addressed by input hash, configuration hash, and algorithm version. They may be deleted and regenerated.

## Data handling boundaries

Raw media and interaction data stay on local storage by default. Logs contain correlation IDs, durations, codecs, hardware capability summaries, and error codes—not screen contents, cursor text, window titles, or raw audio. Optional future telemetry uses a distinct consented pipeline.
