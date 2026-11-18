import { describe, expect, it } from 'vitest';

import { asProjectId, isOpaqueId, projectIdSchema } from './ids';

describe('opaque identifiers', () => {
  it.each(['a', 'project_01', '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90', 'A'.repeat(128)])(
    'accepts %s',
    (value) => {
      expect(isOpaqueId(value)).toBe(true);
      expect(asProjectId(value)).toBe(value);
      expect(projectIdSchema.parse(value)).toBe(value);
    },
  );

  it.each(['', ' ', '../x', 'a/b', 'a\\b', 'a.b', '-leading-dash', 'A'.repeat(129), 'é'])(
    'rejects %j because it could escape a path or is malformed',
    (value) => {
      expect(isOpaqueId(value)).toBe(false);
      expect(() => asProjectId(value)).toThrow(TypeError);
      expect(projectIdSchema.safeParse(value).success).toBe(false);
    },
  );
});
