import { describe, expect, it } from 'vitest';

import { buildContentSecurityPolicy } from './content-security-policy';

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(';').map((part) => {
      const [name = '', ...sources] = part.trim().split(/\s+/);
      return [name, sources];
    }),
  );
}

describe('buildContentSecurityPolicy', () => {
  it('locks production down to the app origin with no eval or inline script', () => {
    const policy = directives(buildContentSecurityPolicy({ mode: 'production' }));
    expect(policy.get('default-src')).toEqual(["'none'"]);
    expect(policy.get('script-src')).toEqual(["'self'"]);
    expect(policy.get('object-src')).toEqual(["'none'"]);
    expect(policy.get('frame-ancestors')).toEqual(["'none'"]);
    expect(policy.get('media-src')).toEqual(["'self'", 'blob:', 'app://media']);
    // Export decodes the open project's recordings from byte ranges; nothing remote.
    expect(policy.get('connect-src')).toEqual(["'self'", 'app://media']);
    expect([...policy.values()].flat()).not.toContain("'unsafe-eval'");
    expect([...policy.values()].flat()).not.toContain("'unsafe-inline'");
  });

  it('allows only what the Vite dev server needs in development', () => {
    const policy = directives(
      buildContentSecurityPolicy({ mode: 'development', devServerOrigin: 'http://127.0.0.1:5173' }),
    );
    expect(policy.get('script-src')).toEqual(["'self'", "'unsafe-inline'"]);
    expect(policy.get('connect-src')).toEqual(["'self'", 'app://media', 'ws://127.0.0.1:5173']);
    expect([...policy.values()].flat()).not.toContain("'unsafe-eval'");
  });
});
