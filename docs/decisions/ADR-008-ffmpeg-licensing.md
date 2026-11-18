# ADR-008: Treat FFmpeg distribution as a governed release dependency

- Status: Accepted
- Date: 2026-09-18

## Context

FFmpeg is valuable for codec/container breadth but binary configuration affects license obligations, security posture, and reproducibility.

## Decision

Pin a manifest-driven application-owned FFmpeg build. Default to an LGPL-compatible configuration until legal review explicitly accepts another configuration. Track source/provenance/checksum/notices/codec flags in release artifacts.

## Candidate build (not approved for distribution)

The initial Windows x64 build candidate is FFmpeg 9.0.2 from the official `ffmpeg-9.0.2.tar.xz` release archive, corresponding to tag `n9.0.2` and source commit `946fcce07b6dcd0331c8cc609192aeff5e1924f8`. Verify the archive's upstream signature before building and record the archive SHA-256, toolchain, complete configure command, and resulting binary SHA-256 in the runtime manifest.

The candidate configuration excludes GPL and nonfree components. The initial output preset requires the native `aac` encoder and Windows Media Foundation `h264_mf` encoder; do not enable `libx264` or other external codec libraries without a separate dependency and license review. This is a build target for validation, not a claim that the binary has been built or that the codecs are cleared for distribution.

Legal review remains open for FFmpeg distribution obligations and H.264 patent exposure. Until that review is recorded against the exact built manifest, there is no approved runtime manifest, packaged executable, or distributable FFmpeg build. Recheck the selected release for security fixes before producing any release binary.

Sources: [FFmpeg release archive and signatures](https://ffmpeg.org/releases/), [FFmpeg legal guidance](https://ffmpeg.org/legal.html), [FFmpeg codec documentation](https://ffmpeg.org/ffmpeg-codecs.html), and [FFmpeg source tag](https://chromium.googlesource.com/external/git.ffmpeg.org/ffmpeg/%2B/refs/tags/upstream/n9.0.2).

## Candidate verification (2026-11-07)

The candidate was built and audited on the development machine; nothing here approves it for distribution.

- Source: `ffmpeg-9.0.2.tar.xz` (SHA-256 `8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e`) and `ffmpeg-9.0.2.tar.gz` (SHA-256 `84960df915059e8754fef2cd7c9afeb614062b1b5458ec471eecee619ee04e98`) both carry a good signature made on 2026-09-18 by the FFmpeg release signing key, fingerprint `FCF9 86EA 15E6 E293 A564 4F10 B432 2F04 D676 58D8`, and both expand to the same tar (SHA-256 `38561541e175908ed29e685ebd6ffbe7387a837dc2777aa01497df14270668e9`). The tree built from matched it file for file. On 2026-11-07 ffmpeg.org listed 9.0.2 as the latest 9.0 release.
- zlib (for PNG, until export moved to raw frames on 2026-11-08; no longer built): `zlib-1.4.tar.gz` (released 2026-11-04), SHA-256 `02dd159783677a749c04adbdd02b55b8a2bcc7e054f51b76b549199a916ad584`, the hash zlib.net publishes; its tree matched the archive.
- Toolchain: MSVC 19.29.30159 (Visual Studio 2019 Build Tools, x64), GNU Make 4.4.1 and NASM 3.02 from MSYS2.
- Configure command, as the export worker's commands need it:

```text
--toolchain=msvc --disable-everything --disable-autodetect --disable-network --disable-doc
--disable-ffplay --disable-ffprobe --disable-debug --enable-ffmpeg --enable-avcodec
--enable-avformat --enable-avfilter --enable-avutil --enable-swscale --enable-swresample
--enable-mediafoundation --enable-d3d11va
--enable-encoder=aac,h264_mf,wrapped_avframe,pcm_s16le --enable-decoder=aac,h264,rawvideo
--enable-hwaccel=h264_d3d11va,h264_d3d11va2 --enable-demuxer=mov,rawvideo
--enable-muxer=mov,mp4,null --enable-protocol=file,pipe --enable-parser=aac,h264
--enable-filter=adelay,amix,apad,aresample,asetpts,atempo,atrim,format,scale
--extra-cflags=-guard:cf --extra-ldflags=-guard:cf
```

The first candidate (binary SHA-256 `02abe9d2b570e6e06a9313cb4e1027de1e5c91e6025f6a0be1a036dd336000ad`) lacked three of these, and each broke something: without the `mp4` muxer every export failed (`Requested output format 'mp4' is not known`); without the `wrapped_avframe` and `pcm_s16le` encoders the validation decode into the null sink could not start; and `--enable-d3d11va` alone builds only the D3D11 API, so without the `h264_d3d11va` hwaccels `-hwaccel d3d11va` silently decoded in software. The capability probe now refuses such a build at startup (`export.ffmpeg-runtime-incomplete`). A build with the command above (binary SHA-256 `c01786b2d55a4689c0833d38bc6c0666e2eb3ae623b2359dcd4904e9be962bba`) passes `tests/integration/ffmpeg-export.test.ts`.

Both builds report "LGPL version 2.1 or later" with GPL, nonfree and network off, link FFmpeg and the C runtime statically into `ffmpeg.exe`, import only Windows system DLLs (Media Foundation and D3D11 are loaded at run time) and are built with ASLR, high-entropy addresses and DEP. They lacked Control Flow Guard, and built zlib against the DLL C runtime, which the linker warned about (LNK4217). Measured on an AMD Radeon integrated GPU: 1080p60 PNG frames encode at about 28 fps with Windows' software H.264 encoder and about 52 fps with the GPU's (NV12 input; PNG decoding then bounds it), and a D3D11 decode feeding the GPU encoder runs at about 159 fps at 720p60.

`npm run build:ffmpeg -- --sources <dir> --msys2 <msys64>` (`scripts/build-ffmpeg.mjs`) now builds the runtime from these pinned inputs (`scripts/ffmpeg-build-config.mjs`): it refuses an archive whose SHA-256 differs, configures FFmpeg with the command above (Control Flow Guard included; until 2026-11-08 it also built zlib with the static C runtime), refuses a binary that does not report the LGPL or the pinned configuration, and writes `resources/ffmpeg/`, laid out as the app's own resources, with `ffmpeg.exe`, its license, `build.json`, the provenance, and `development-manifest.json`, which names no review and which only an unpackaged build reads. It writes `runtime-manifest.json`, and prints its SHA-256 for the release trust anchor, only when `--review-reference` and `--reviewed-at` name the legal review. Its first build (binary SHA-256 `3c674c39b8769f9d5048e2291432a6af6125dab45eef1e12d4674b3024e254d5`; each build's hash differs, since the linker stamps the time) has Control Flow Guard (CF instrumented, FID table), no link warnings, hardware D3D11 decoding, and passes `tests/integration/ffmpeg-export.test.ts`. `tests/integration/ffmpeg-build-config.test.ts` keeps the script's flags equal to the command above and covering every component the capability probe requires.

Raw frames (2026-11-08): the renderer spent as long encoding each composed frame as a PNG as on everything else (about 55 ms of 136 ms a frame at 1080p), so it now sends the canvas's raw RGBA pixels and the worker reads them with the `rawvideo` demuxer and decoder at the output's size, refusing any frame that is not exactly width × height × 4 bytes. FFmpeg so no longer parses an image a renderer made. The first build with this command (binary SHA-256 `922e7c57c5979db29ba69a4314e3b9d1c85ca88ba7ea2bef150ded86aafe8ce9`) passes `tests/integration/ffmpeg-export.test.ts` and `tests/e2e/export.spec.ts`. The `image2pipe` demuxer and the PNG decoder and parser left the command, and with PNG gone so did zlib: the runtime is FFmpeg alone, and the build script no longer builds or ships zlib. The capability probe also lists demuxers now, so a build that cannot read the raw frames or the recordings is refused at startup like one without the mp4 muxer.

The review is [ADR-012](ADR-012-ffmpeg-release.md) (2026-11-18): the owner's decision to release FFmpeg with usee as free, open-source software. Still open: the release build with its runtime manifest and trust anchor.

## Consequences

The product does not depend on an arbitrary system binary. GPL components and patent-sensitive codec choices require review before distribution. Releases carry extra compliance work, preventing accidental license drift.
