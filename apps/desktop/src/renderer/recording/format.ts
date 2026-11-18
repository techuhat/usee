/** `m:ss`, or `h:mm:ss` from one hour, for a duration in microseconds. */
export function formatDuration(durationUs: number): string {
  const totalSeconds = Math.floor(Math.max(0, durationUs) / 1_000_000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}
