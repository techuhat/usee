# Performance architecture and budgets

## Principles

Large media must stay on disk or GPU memory until needed. Processes communicate control data, not frames. The renderer remains responsive because encoding, FFmpeg, project migration, proxy generation, and analysis are outside its event loop.

## Initial measurable gates

These are release gates to be calibrated on named reference hardware during the recording vertical slice—not promises before profiling.

| Scenario                                  | Metric                                   | Gate                                                                            |
| ----------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------- |
| Idle, empty project                       | Renderer responsiveness / memory         | Establish baseline and prevent regression beyond agreed percentage              |
| 1080p 60 FPS screen + mic + system audio  | Dropped-frame and A/V drift metrics      | Meet product quality target over a 30-minute reference run                      |
| 1440p/4K capture                          | Bounded queues and process stability     | No unbounded memory growth; explicit fallback if hardware cannot sustain target |
| Long session                              | Recovery durability                      | Valid prior segments recover after forced host termination                      |
| Timeline interaction under background job | Input-to-paint latency                   | UI remains interactive; job priority throttles when necessary                   |
| Export                                    | UI responsiveness and output correctness | Main/renderer never block; result passes probe/quality validation               |

Exact numerical budgets are established after representative hardware benchmarking, then versioned in this document and enforced in CI/lab dashboards. Premature fixed numbers would be false precision.

## Phase 1 baseline (2026-10-17)

Reference machine: AMD Ryzen 3 3250U (2 cores, 4 threads), Radeon Vega 3 integrated GPU with its hardware H.264 encoder, 14 GB RAM, one 3840×2160 display at 60 Hz with 200% scaling. Each run recorded a mostly static desktop for about 60 seconds; motion-heavy content still needs measuring.

| Run                           | Encoded size | Frames encoded / dropped    | Host CPU (whole machine) | Host peak memory |
| ----------------------------- | ------------ | --------------------------- | ------------------------ | ---------------- |
| Native 4K at 60 fps           | 3840×2160    | 202 / 3,635 (94.7% dropped) | 12.9%                    | 309 MB           |
| GPU-scaled to 1080p at 60 fps | 1920×1080    | 3,744 / 14 (0.37% dropped)  | 15.9%                    | 93 MB            |

Native 4K at 60 fps is beyond this hardware, so the host scales any display larger than 1920×1080 down on the GPU's video engine before encoding. That is the explicit fallback the 1440p/4K gate requires. Memory stayed flat in both runs: the overload policy drops late ticks instead of queueing them. A 10-second run with the microphone kept audio and video within 70 ms of each other, with no discontinuities.

Open: the hardware encoder averaged about 25 Mbps against a 12.4 Mbps target, so rate control needs tuning; the 30-minute soak and A/V drift runs are still to do.

## Design choices that protect performance

- GPU-resident WGC/D3D11 capture and hardware encode where safe; capability-probe plus software fallback.
- Segmented streaming writers, bounded queues, and explicit overload policy rather than unbounded buffering.
- Proxy media, thumbnails, waveforms, cursor derivations, and analysis run as cancellable background jobs.
- Immutable project snapshots and structured render plans avoid repeated graph walking on the UI thread.
- Resource manager limits concurrent decode/export jobs and releases GPU/encoder handles deterministically.
- Media metadata is indexed; project open does not eagerly decode every asset.

## Observability

Record only safe performance telemetry locally: capture FPS, drops, queue depth, audio drift, encoder name/fallback reason, render stage duration, disk throughput category, memory high-water mark, and correlation IDs. Add opt-in upload only after a privacy and product review.
