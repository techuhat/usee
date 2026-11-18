import { describe, expect, it } from 'vitest';

import { decodeWaveform } from './waveform';

const file = {
  format: 'usee.waveform',
  version: 1,
  producer: 'recorder-host',
  algorithm: 'peak-abs-u8',
  inputSha256: 'a'.repeat(64),
  sampleRateHz: 48_000,
  peaksPerSecond: 100,
  peakCount: 3,
  generatedAt: '2026-11-18T00:00:00.000Z',
  peaks: 'AAEC',
};

describe('decodeWaveform', () => {
  it('reads the peaks the host wrote', () => {
    const decoded = decodeWaveform(JSON.stringify(file));
    expect(decoded.ok && decoded.value.peakCount).toBe(3);
  });

  it('reads a waveform written under the working title', () => {
    const decoded = decodeWaveform(JSON.stringify({ ...file, format: 'screen-studio.waveform' }));
    expect(decoded.ok).toBe(true);
  });

  it('refuses another format', () => {
    expect(decodeWaveform(JSON.stringify({ ...file, format: 'other.waveform' })).ok).toBe(false);
  });
});
