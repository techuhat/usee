# ADR-012: Release FFmpeg with usee as free, open-source software

- Status: Accepted
- Date: 2026-11-18
- Owner: the project owner, who decided on 2026-11-18 to publish usee free and open source under the MIT License and accepted the codec patent question below for that release. Maintained with the export runtime (ADR-008).

## Context

ADR-008 keeps the FFmpeg runtime out of packaged builds until a review accepts it for distribution: its LGPL obligations, and the patents on H.264 and AAC. On 2026-11-18 the owner chose to publish usee as free, open-source software that anyone may use, from a public repository, with no paid tier (docs/roadmap.md).

## Decision

This record is the review ADR-008 asks for: the owner's decision, made without a lawyer's opinion. `npm run build:ffmpeg` names it with `--review-reference docs/decisions/ADR-012-ffmpeg-release.md --reviewed-at 2026-11-18T00:00:00Z` (the runtime manifest takes a full ISO time).

### LGPL obligations

FFmpeg's checklist ([ffmpeg.org/legal.html](https://ffmpeg.org/legal.html)) and how usee meets each point:

- No GPL and no non-free parts: the configure command enables neither, and the build refuses a binary that reports otherwise (ADR-008).
- Linking: usee does not link FFmpeg. It runs `ffmpeg.exe`, built from FFmpeg's source alone, as a separate program, so the checklist's rule to link FFmpeg's libraries dynamically has nothing to apply to; `ffmpeg.exe` is distributed with its source, licence and notices as below.
- Source: the official, unmodified `ffmpeg-9.0.2.tar.xz`, whose signature and SHA-256 ADR-008 records. With no changes there is no diff to publish. Each release attaches that archive and the runtime's `build.json`, which holds the configure command, beside the installer, on the same server.
- How it was built: the configure command is in ADR-008, in `build.json` and in the runtime manifest.
- Notices: the app's About card names FFmpeg and its licence; the README, which is the download page, names FFmpeg and links to it, to the LGPL 2.1 and to the source; `LICENSE-ffmpeg.txt` ships beside `ffmpeg.exe`.
- Licence terms: the installer shows no EULA. usee's MIT License claims no ownership of FFmpeg and forbids no reverse engineering.
- Name: FFmpeg is spelled as its project spells it, and `ffmpeg.exe` keeps its name.

### Patents

FFmpeg grants no patent licence, and H.264 and AAC are covered by patent pools (administered by Via LA). In usee:

- H.264 encoding is Windows' own Media Foundation encoder (`h264_mf`), the GPU vendor's or Microsoft's, which FFmpeg only calls;
- FFmpeg's own code decodes H.264, to check each finished export, and encodes and decodes AAC;
- Electron's Chromium also decodes H.264 and AAC, to play recordings in the editor, whether or not FFmpeg ships.

The owner accepts this for a free, open-source release, as many open-source recorders and editors ship these codecs. Before usee is sold, or distributed for profit, this decision is reviewed again with a lawyer.

### Release

For Phase 7's exit: check FFmpeg 9.0 for security releases; build the runtime with this review named; set its manifest's SHA-256 as the trust anchor in `apps/desktop/src/main/ffmpeg-runtime-trust.ts`; and attach FFmpeg's source and `build.json` to the release.

## Consequences

A packaged usee can export once that runtime is built. Its sources are no longer on the development machine, so the build downloads the archive again (the script checks its SHA-256), on a network that does not inspect HTTPS or in CI. The patent risk is the owner's and is stated here; selling usee reopens it.
