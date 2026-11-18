import { createAppError, err, ok, type CorrelationId, type Result } from '@usee/contracts';
import type { ExportJob, Project, RenderPlan } from '@usee/domain';

import type { PreparedExportJob } from './export-ports';
import { compileRenderPlan } from './render-plan';

export type RenderPlanHasher = (plan: RenderPlan) => string;

type ExportPreparationErrorCode =
  | 'export.project-mismatch'
  | 'export.job-not-queued'
  | 'export.plan-hash-failed'
  | 'export.plan-hash-invalid';

function failure(code: ExportPreparationErrorCode, correlationId: CorrelationId) {
  return err(
    createAppError({
      category: 'export',
      code,
      retryable: false,
      userMessageKey: `errors.${code}`,
      correlationId,
    }),
  );
}

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function cloneValue<Value>(value: Value): Value {
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    for (const child of value as unknown[]) {
      clone.push(cloneValue<unknown>(child));
    }
    return clone as Value;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const clone: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    clone[key] = cloneValue<unknown>(child);
  }
  return clone as Value;
}

export function snapshotRenderPlan(plan: RenderPlan): RenderPlan {
  return deepFreeze(cloneValue(plan));
}

/** Compiles an immutable project revision and binds its hash to the queued job. */
export function prepareExportJob(
  project: Project,
  job: ExportJob,
  correlationId: CorrelationId,
  hashPlan: RenderPlanHasher,
): Result<PreparedExportJob> {
  if (job.projectId !== project.id) {
    return failure('export.project-mismatch', correlationId);
  }
  if (job.state !== 'queued') {
    return failure('export.job-not-queued', correlationId);
  }

  const compiled = compileRenderPlan(project, job.preset.id, correlationId);
  if (!compiled.ok) {
    return compiled;
  }
  const plan = snapshotRenderPlan(compiled.value);
  let planHash: string;
  try {
    planHash = hashPlan(plan);
  } catch {
    return failure('export.plan-hash-failed', correlationId);
  }
  if (!/^[0-9a-f]{64}$/.test(planHash)) {
    return failure('export.plan-hash-invalid', correlationId);
  }

  const exportJob = deepFreeze({
    id: job.id,
    projectId: project.id,
    state: 'queued' as const,
    preset: plan.preset,
    destinationPath: job.destinationPath,
    createdAtUs: job.createdAtUs,
  });
  return ok(Object.freeze({ job: exportJob, plan, planHash }));
}
