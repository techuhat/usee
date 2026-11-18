/** An inclusive byte range of a file, as HTTP `Range` and `Content-Range` count. */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Reads a `Range: bytes=…` header against a file of `size` bytes, the way
 * media elements ask for the part they need when seeking. Returns undefined
 * to send the whole file (no header, or one this server ignores, such as
 * several ranges), or `unsatisfiable` for a 416.
 */
export function parseByteRange(
  header: string | null,
  size: number,
): ByteRange | 'unsatisfiable' | undefined {
  if (header === null) {
    return undefined;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) {
    return undefined;
  }
  const [, first = '', last = ''] = match;
  if (first === '' && last === '') {
    return undefined;
  }
  if (first === '') {
    // A suffix: the last N bytes.
    const length = Number(last);
    if (length === 0 || size === 0) {
      return 'unsatisfiable';
    }
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(first);
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  if (start >= size || end < start) {
    return 'unsatisfiable';
  }
  return { start, end };
}
