import { createHash } from 'node:crypto';

import type { RenderPlan } from '@usee/domain';

import { canonicalJson } from './canonical-json';

/** SHA-256 over the canonical semantic plan, excluding paths and runtime state. */
export function hashRenderPlan(plan: RenderPlan): string {
  return createHash('sha256').update(canonicalJson(plan), 'utf8').digest('hex');
}
