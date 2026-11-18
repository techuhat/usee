const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9 ._-]*$/;
const RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i;

/**
 * True for a bundle-relative path that cannot leave the bundle or misbehave
 * on Windows: forward slashes only, no `.`/`..` or empty segments, no drive
 * letters, no reserved device names, no trailing dot or space.
 */
export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 240) {
    return false;
  }
  return path
    .split('/')
    .every(
      (segment) =>
        SEGMENT.test(segment) &&
        !RESERVED.test(segment) &&
        !segment.endsWith('.') &&
        !segment.endsWith(' '),
    );
}
