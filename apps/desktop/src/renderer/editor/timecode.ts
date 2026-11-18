/** `m:ss.cc` (hundredths), or `h:mm:ss.cc` from one hour, for a time in microseconds. */
export function formatTimecode(timeUs: number): string {
  const totalHundredths = Math.floor(Math.max(0, timeUs) / 10_000);
  const hundredths = String(totalHundredths % 100).padStart(2, '0');
  const totalSeconds = Math.floor(totalHundredths / 100);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}.${hundredths}`
    : `${minutes}:${seconds}.${hundredths}`;
}
