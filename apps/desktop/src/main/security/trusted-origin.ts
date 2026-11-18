/**
 * `scheme://host[:port]` of a URL. WHATWG URL gives custom schemes such as
 * app:// an opaque `origin` of "null", so the origin is rebuilt from parts.
 */
export function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.host === '' ? undefined : `${parsed.protocol}//${parsed.host}`;
  } catch {
    return undefined;
  }
}

export function isTrustedUrl(url: string, trustedOrigins: readonly string[]): boolean {
  const origin = originOf(url);
  return origin !== undefined && trustedOrigins.includes(origin);
}
