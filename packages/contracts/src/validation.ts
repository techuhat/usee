import { z } from 'zod';

/**
 * Zod compiles faster object parsers with `new Function` when it can. The
 * renderer and preload run under a CSP without 'unsafe-eval', so they call this
 * once at startup to keep validation interpreted and avoid CSP violations.
 */
export function disableValidationCodeGeneration(): void {
  z.config({ jitless: true });
}
