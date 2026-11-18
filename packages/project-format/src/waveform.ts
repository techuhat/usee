import { z } from 'zod';

import { err, ok, type Result } from '@usee/contracts';

/** Ten hours at the host's 100 peaks per second. */
const MAX_PEAKS = 3_600_000;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodedLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

/**
 * `derived/waveforms/<asset id>.json`: the peak amplitude of an asset's audio
 * per 1/`peaksPerSecond` of a second, 0-255, written by the recorder host.
 * Like every derived artifact it records its producer, algorithm and input
 * hash (docs/project-format.md); a missing or invalid file only means the
 * editor draws no peaks.
 */
export const waveformFileSchema = z
  .object({
    // Written before 2026-11-18, under the working title, as `screen-studio.waveform`.
    format: z.enum(['usee.waveform', 'screen-studio.waveform']),
    version: z.literal(1),
    producer: z.string().min(1).max(64),
    algorithm: z.literal('peak-abs-u8'),
    inputSha256: z.string().regex(/^[0-9a-f]{64}$/),
    sampleRateHz: z.number().int().positive(),
    peaksPerSecond: z.number().int().min(1).max(1_000),
    peakCount: z.number().int().nonnegative().max(MAX_PEAKS),
    generatedAt: z.iso.datetime(),
    peaks: z
      .string()
      .max(Math.ceil(MAX_PEAKS / 3) * 4)
      .regex(BASE64),
  })
  .refine((file) => decodedLength(file.peaks) === file.peakCount, {
    error: 'peakCount does not match the encoded peaks.',
  });
export type WaveformFile = z.output<typeof waveformFileSchema>;

/** Bundle-relative path of an asset's waveform. */
export function waveformPath(assetId: string): string {
  return `derived/waveforms/${assetId}.json`;
}

export function decodeWaveform(serialized: string): Result<WaveformFile, string> {
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch {
    return err('waveform is not valid JSON');
  }
  const parsed = waveformFileSchema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : err(parsed.error.issues[0]?.message ?? 'invalid');
}
