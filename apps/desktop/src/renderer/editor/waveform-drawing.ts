import type { DecodedWaveform } from './project-store';

/**
 * Draws the peaks of a clip's source range across the canvas, one column per
 * device pixel, each the loudest peak it covers. The square root lifts quiet
 * speech so it stays visible beside loud passages.
 */
export function drawWaveform(
  canvas: HTMLCanvasElement,
  waveform: DecodedWaveform,
  sourceStartUs: number,
  durationUs: number,
  color: string,
): void {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) {
    return;
  }
  context.clearRect(0, 0, width, height);
  context.fillStyle = color;

  const peaksPerUs = waveform.peaksPerSecond / 1_000_000;
  const first = sourceStartUs * peaksPerUs;
  const perColumn = (durationUs * peaksPerUs) / width;
  for (let column = 0; column < width; column += 1) {
    const from = Math.floor(first + column * perColumn);
    const to = Math.max(from + 1, Math.floor(first + (column + 1) * perColumn));
    let peak = 0;
    for (let index = from; index < to && index < waveform.peaks.length; index += 1) {
      peak = Math.max(peak, waveform.peaks[index] ?? 0);
    }
    const bar = Math.sqrt(peak / 255) * height;
    context.fillRect(column, (height - bar) / 2, 1, Math.max(1, bar));
  }
}
