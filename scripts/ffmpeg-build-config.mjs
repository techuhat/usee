// @ts-check
/**
 * The FFmpeg runtime export uses, pinned (docs/decisions/ADR-008): the
 * source and its SHA-256, verified on 2026-11-07 against the FFmpeg
 * release key's signatures, and the configure command the export worker's
 * commands need. scripts/build-ffmpeg.mjs builds
 * from this; tests keep it in step with ADR-008 and the capability probe.
 */

export const FFMPEG_SOURCE = Object.freeze({
  version: '9.0.2',
  archive: 'ffmpeg-9.0.2.tar.xz',
  sha256: '8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e',
  url: 'https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz',
  /** The source commit of tag n9.0.2. */
  revision: '946fcce07b6dcd0331c8cc609192aeff5e1924f8',
  directory: 'ffmpeg-9.0.2',
});

/** ADR-008's configure command, flag by flag. */
export const CONFIGURE_FLAGS = Object.freeze([
  '--toolchain=msvc',
  '--disable-everything',
  '--disable-autodetect',
  '--disable-network',
  '--disable-doc',
  '--disable-ffplay',
  '--disable-ffprobe',
  '--disable-debug',
  '--enable-ffmpeg',
  '--enable-avcodec',
  '--enable-avformat',
  '--enable-avfilter',
  '--enable-avutil',
  '--enable-swscale',
  '--enable-swresample',
  '--enable-mediafoundation',
  '--enable-d3d11va',
  '--enable-encoder=aac,h264_mf,wrapped_avframe,pcm_s16le',
  '--enable-decoder=aac,h264,rawvideo',
  '--enable-hwaccel=h264_d3d11va,h264_d3d11va2',
  '--enable-demuxer=mov,rawvideo',
  '--enable-muxer=mov,mp4,null',
  '--enable-protocol=file,pipe',
  '--enable-parser=aac,h264',
  '--enable-filter=adelay,amix,apad,aresample,asetpts,atempo,atrim,format,scale',
]);

/** Control Flow Guard for the C code and the link (ADR-008, hardening). */
export const HARDENING_FLAGS = Object.freeze([
  '--extra-cflags=-guard:cf',
  '--extra-ldflags=-guard:cf',
]);

/**
 * The encoders the app may offer as choices; the build has more, used only
 * inside the export commands (the null sink's), never offered.
 */
export const APPROVED_ENCODERS = Object.freeze(['aac', 'h264_mf']);

/** What a release ships beside ffmpeg.exe in resources/ffmpeg, its SHA-256 the trust anchor. */
export const RUNTIME_MANIFEST_FILE = 'runtime-manifest.json';
/**
 * What only an unpackaged development build reads (apps/desktop/src/main/
 * export-runtime-source.ts): a manifest that names no legal review, so a
 * release can never mistake it for its own.
 */
export const DEVELOPMENT_MANIFEST_FILE = 'development-manifest.json';

/**
 * The runtime manifest the app verifies at startup
 * (`ffmpegRuntimeManifestSchema` in packages/contracts). Written only for a
 * build a legal review has accepted: `review` names that review.
 *
 * @param {{
 *   sha256: string,
 *   builtAt: string,
 *   review: { reference: string, reviewedAt: string },
 * }} build
 */
export function runtimeManifest(build) {
  return {
    manifestVersion: 1,
    version: FFMPEG_SOURCE.version,
    binaryName: 'ffmpeg.exe',
    sha256: build.sha256,
    source: { url: FFMPEG_SOURCE.url, revision: FFMPEG_SOURCE.revision },
    license: {
      spdx: 'LGPL-2.1-or-later',
      reviewReference: build.review.reference,
      reviewedAt: build.review.reviewedAt,
    },
    builtAt: build.builtAt,
    configureFlags: [...CONFIGURE_FLAGS, ...HARDENING_FLAGS],
    enabledEncoders: [...APPROVED_ENCODERS],
  };
}

/**
 * The manifest a development build verifies the binary against: the same
 * shape, its review plainly none.
 *
 * @param {{ sha256: string, builtAt: string }} build
 */
export function developmentManifest(build) {
  return runtimeManifest({
    ...build,
    review: { reference: 'UNREVIEWED development build, never shipped', reviewedAt: build.builtAt },
  });
}
