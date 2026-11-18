import {
  createAppError,
  err,
  ok,
  type AppError,
  type CancellationToken,
  type CorrelationId,
  type JobId,
  type Result,
} from '@usee/contracts';
import {
  EXPORT_PRESETS,
  type ExportJob,
  type ExportJobState,
  type ExportPreset,
  type RenderJob,
  type RenderPlan,
} from '@usee/domain';

import type {
  ActiveExportState,
  ExportCoordinatorPort,
  ExportCoordinatorUpdate,
  ExportJobStorePort,
  PersistedExportJob,
  PreparedExportJob,
  ExportWorkerPort,
} from './export-ports';
import { snapshotRenderPlan } from './export-preparation';

export interface ExportCoordinatorDependencies {
  readonly worker: ExportWorkerPort;
  readonly hashPlan: (plan: RenderPlan) => string;
  readonly createRenderJobId: () => JobId;
  readonly createCorrelationId: () => CorrelationId;
  readonly jobStore?: ExportJobStorePort;
  /** Number of terminal jobs retained in memory and on disk. Defaults to 100. */
  readonly maxHistoryEntries?: number;
}

interface JobRecord {
  readonly prepared: PreparedExportJob;
  readonly externalCancellation: CancellationToken | undefined;
  update: ExportCoordinatorUpdate;
  cancelRequested: boolean;
  protocolViolation: boolean;
}

const ACTIVE_STATES: readonly ActiveExportState[] = ['rendering', 'validating', 'publishing'];
const STATE_ORDER: Readonly<Record<ExportJobState, number>> = {
  queued: 0,
  preparing: 1,
  rendering: 2,
  validating: 3,
  publishing: 4,
  succeeded: 5,
  canceled: 5,
  failed: 5,
};

function isTerminal(state: ExportJobState): boolean {
  return state === 'succeeded' || state === 'canceled' || state === 'failed';
}

function snapshotJob(job: ExportJob): ExportJob {
  return {
    ...job,
    preset: {
      ...job.preset,
      dimensions: { ...job.preset.dimensions },
      frameRate: { ...job.preset.frameRate },
    },
  };
}

function isApprovedPreset(preset: ExportPreset): boolean {
  return JSON.stringify(preset) === JSON.stringify(EXPORT_PRESETS[preset.id]);
}

/** Serial, cooperative export queue. The worker owns media and filesystem work. */
export class ExportCoordinator implements ExportCoordinatorPort {
  readonly #deps: ExportCoordinatorDependencies;
  readonly #maxHistoryEntries: number;
  readonly #jobs = new Map<JobId, JobRecord>();
  readonly #exportJobIds = new Set<JobId>();
  readonly #queue: JobRecord[] = [];
  readonly #listeners = new Set<(update: ExportCoordinatorUpdate) => void>();
  #initialization: Promise<Result<void>> | undefined;
  #persistTail: Promise<Result<void>> = Promise.resolve(ok(undefined));
  #mutationTail: Promise<void> = Promise.resolve();
  #active: JobRecord | undefined;

  constructor(dependencies: ExportCoordinatorDependencies) {
    this.#deps = dependencies;
    this.#maxHistoryEntries = dependencies.maxHistoryEntries ?? 100;
    if (!Number.isSafeInteger(this.#maxHistoryEntries) || this.#maxHistoryEntries < 0) {
      throw new RangeError('Export history retention must be a non-negative safe integer.');
    }
  }

  initialize(): Promise<Result<void>> {
    this.#initialization ??= this.#restore();
    return this.#initialization;
  }

  enqueue(
    preparedJob: PreparedExportJob,
    cancellation?: CancellationToken,
  ): Promise<Result<RenderJob>> {
    return this.#serializeMutation(() => this.#enqueue(preparedJob, cancellation));
  }

  async #enqueue(
    preparedJob: PreparedExportJob,
    cancellation: CancellationToken | undefined,
  ): Promise<Result<RenderJob>> {
    const initialized = await this.initialize();
    if (!initialized.ok) {
      return err(initialized.error);
    }
    const job = preparedJob.job;
    if (job.state !== 'queued') {
      return Promise.resolve(err(this.#error('export.job-not-queued')));
    }
    if (
      preparedJob.plan.projectId !== job.projectId ||
      preparedJob.plan.preset.id !== job.preset.id ||
      !isApprovedPreset(job.preset) ||
      !isApprovedPreset(preparedJob.plan.preset) ||
      !/^[0-9a-f]{64}$/.test(preparedJob.planHash)
    ) {
      return Promise.resolve(err(this.#error('export.prepared-job-invalid')));
    }
    if (this.#exportJobIds.has(job.id)) {
      return Promise.resolve(err(this.#error('export.job-duplicate')));
    }
    const id = this.#deps.createRenderJobId();
    if (this.#jobs.has(id)) {
      return Promise.resolve(err(this.#error('export.job-duplicate')));
    }

    let plan: RenderPlan;
    try {
      plan = snapshotRenderPlan(preparedJob.plan);
      if (this.#deps.hashPlan(plan) !== preparedJob.planHash) {
        return err(this.#error('export.plan-hash-mismatch'));
      }
    } catch {
      return Promise.resolve(err(this.#error('export.plan-hash-failed')));
    }
    const prepared: PreparedExportJob = Object.freeze({
      job: snapshotJob(job),
      plan,
      planHash: preparedJob.planHash,
    });
    const record: JobRecord = {
      prepared,
      externalCancellation: cancellation,
      update: {
        job: {
          id,
          exportJobId: prepared.job.id,
          state: 'queued',
          progress: 0,
          createdAtUs: prepared.job.createdAtUs,
        },
        error: null,
      },
      cancelRequested: false,
      protocolViolation: false,
    };
    this.#jobs.set(id, record);
    this.#exportJobIds.add(prepared.job.id);
    this.#queue.push(record);
    const persisted = await this.#schedulePersistence();
    if (!persisted.ok) {
      this.#jobs.delete(id);
      this.#exportJobIds.delete(prepared.job.id);
      const queuedIndex = this.#queue.indexOf(record);
      if (queuedIndex >= 0) {
        this.#queue.splice(queuedIndex, 1);
      }
      return err(persisted.error);
    }
    this.#publish(record);
    const queuedJob = record.update.job;
    this.#startNext();
    return Promise.resolve(ok(queuedJob));
  }

  cancel(renderJobId: JobId): Promise<Result<void>> {
    return this.#serializeMutation(() => this.#cancel(renderJobId));
  }

  async #cancel(renderJobId: JobId): Promise<Result<void>> {
    const initialized = await this.initialize();
    if (!initialized.ok) {
      return initialized;
    }
    const record = this.#jobs.get(renderJobId);
    if (record === undefined) {
      return err(this.#error('export.job-not-found'));
    }
    if (isTerminal(record.update.job.state)) {
      return err(this.#error('export.job-terminal'));
    }

    record.cancelRequested = true;
    if (record.update.job.state === 'queued') {
      const queuedIndex = this.#queue.indexOf(record);
      if (queuedIndex >= 0) {
        this.#queue.splice(queuedIndex, 1);
      }
      this.#set(record, 'canceled', record.update.job.progress, null);
      const persisted = await this.#flushPersistence();
      if (!persisted.ok) {
        record.cancelRequested = false;
        record.update = { job: { ...record.update.job, state: 'queued' }, error: null };
        if (queuedIndex >= 0) {
          this.#queue.splice(queuedIndex, 0, record);
        }
        this.#publish(record);
        return persisted;
      }
    }
    return ok(undefined);
  }

  get(renderJobId: JobId): Result<ExportCoordinatorUpdate> {
    const record = this.#jobs.get(renderJobId);
    return record === undefined ? err(this.#error('export.job-not-found')) : ok(record.update);
  }

  list(): readonly ExportCoordinatorUpdate[] {
    return [...this.#jobs.values()]
      .map(({ update }) => update)
      .sort((first, second) => second.job.createdAtUs - first.job.createdAtUs);
  }

  subscribe(listener: (update: ExportCoordinatorUpdate) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #startNext(): void {
    if (this.#active !== undefined) {
      return;
    }
    let record: JobRecord | undefined;
    while ((record = this.#queue.shift()) !== undefined) {
      if (isTerminal(record.update.job.state)) {
        continue;
      }
      if (this.#isCancellationRequested(record)) {
        this.#set(record, 'canceled', record.update.job.progress, null);
        continue;
      }
      break;
    }
    if (record === undefined) {
      return;
    }

    this.#active = record;
    this.#set(record, 'preparing', 0, null);
    void this.#run(record).finally(() => {
      if (this.#active === record) {
        this.#active = undefined;
      }
      this.#startNext();
    });
  }

  async #run(record: JobRecord): Promise<void> {
    try {
      const persisted = await this.#flushPersistence();
      if (!persisted.ok) {
        this.#set(record, 'failed', record.update.job.progress, persisted.error);
        return;
      }

      let result: Result<void>;
      try {
        result = await this.#deps.worker.run(
          record.prepared.job,
          record.prepared.plan,
          record.prepared.planHash,
          this.#cancellationToken(record),
          (state, progress) => this.#onWorkerUpdate(record, state, progress),
        );
      } catch {
        if (record.protocolViolation) {
          this.#set(
            record,
            'failed',
            record.update.job.progress,
            this.#error('export.worker-protocol'),
          );
        } else if (this.#isCancellationRequested(record)) {
          this.#set(record, 'canceled', record.update.job.progress, null);
        } else {
          this.#set(
            record,
            'failed',
            record.update.job.progress,
            this.#error('export.worker-failed'),
          );
        }
        return;
      }

      if (record.protocolViolation) {
        this.#set(
          record,
          'failed',
          record.update.job.progress,
          this.#error('export.worker-protocol'),
        );
      } else if (!result.ok && this.#isCancellationRequested(record)) {
        this.#set(record, 'canceled', record.update.job.progress, null);
      } else if (!result.ok) {
        this.#set(record, 'failed', record.update.job.progress, result.error);
      } else if (record.update.job.state === 'publishing') {
        this.#set(record, 'succeeded', 1, null);
      } else if (this.#isCancellationRequested(record)) {
        this.#set(record, 'canceled', record.update.job.progress, null);
      } else {
        this.#set(
          record,
          'failed',
          record.update.job.progress,
          this.#error('export.worker-protocol'),
        );
      }
    } finally {
      await this.#flushPersistence();
    }
  }

  async #restore(): Promise<Result<void>> {
    if (this.#deps.jobStore === undefined) {
      return ok(undefined);
    }

    let loaded: Result<readonly PersistedExportJob[]>;
    try {
      loaded = await this.#deps.jobStore.load();
    } catch {
      return err(this.#error('export.persistence-failed'));
    }
    if (!loaded.ok) {
      return loaded;
    }

    const restored: JobRecord[] = [];
    const renderIds = new Set<JobId>();
    const exportIds = new Set<JobId>();
    let reconciledInterruptedJob = false;
    for (const entry of loaded.value) {
      const { prepared, update } = entry;
      if (
        prepared.job.state !== 'queued' ||
        prepared.job.projectId !== prepared.plan.projectId ||
        prepared.job.preset.id !== prepared.plan.preset.id ||
        !isApprovedPreset(prepared.job.preset) ||
        !isApprovedPreset(prepared.plan.preset) ||
        update.job.exportJobId !== prepared.job.id ||
        update.job.createdAtUs !== prepared.job.createdAtUs ||
        renderIds.has(update.job.id) ||
        exportIds.has(prepared.job.id)
      ) {
        return err(this.#error('export.persisted-job-invalid'));
      }

      let plan: RenderPlan;
      try {
        plan = snapshotRenderPlan(prepared.plan);
        if (this.#deps.hashPlan(plan) !== prepared.planHash) {
          return err(this.#error('export.plan-hash-mismatch'));
        }
      } catch {
        return err(this.#error('export.plan-hash-failed'));
      }

      renderIds.add(update.job.id);
      exportIds.add(prepared.job.id);
      const interrupted =
        update.job.state === 'preparing' ||
        update.job.state === 'rendering' ||
        update.job.state === 'validating' ||
        update.job.state === 'publishing';
      const recoveredUpdate = interrupted
        ? {
            job: { ...update.job, state: 'failed' as const },
            error: this.#error('export.interrupted'),
          }
        : update;
      reconciledInterruptedJob ||= interrupted;
      const record: JobRecord = {
        prepared: Object.freeze({
          job: snapshotJob(prepared.job),
          plan,
          planHash: prepared.planHash,
        }),
        externalCancellation: undefined,
        update: recoveredUpdate,
        cancelRequested: false,
        protocolViolation: false,
      };
      restored.push(record);
    }

    for (const record of restored) {
      this.#jobs.set(record.update.job.id, record);
      this.#exportJobIds.add(record.prepared.job.id);
      if (record.update.job.state === 'queued') {
        this.#queue.push(record);
      }
      this.#publish(record);
    }

    const historyTrimmed = this.#hasExcessHistory();
    if (reconciledInterruptedJob || historyTrimmed) {
      const persisted = await this.#schedulePersistence();
      if (!persisted.ok) {
        return persisted;
      }
    }
    this.#startNext();
    return ok(undefined);
  }

  #onWorkerUpdate(record: JobRecord, state: ActiveExportState, progress: number): void {
    if (record !== this.#active || isTerminal(record.update.job.state)) {
      record.protocolViolation = true;
      record.cancelRequested = true;
      return;
    }
    const currentState = record.update.job.state;
    const validState = ACTIVE_STATES.includes(state);
    const validProgress =
      Number.isFinite(progress) && progress >= record.update.job.progress && progress <= 1;
    const sameOrNextState =
      state === currentState || STATE_ORDER[state] === STATE_ORDER[currentState] + 1;
    if (!validState || !validProgress || !sameOrNextState) {
      record.protocolViolation = true;
      record.cancelRequested = true;
      return;
    }
    this.#set(record, state, progress, null);
  }

  #isCancellationRequested(record: JobRecord): boolean {
    return record.cancelRequested || record.externalCancellation?.isCancellationRequested === true;
  }

  #cancellationToken(record: JobRecord): CancellationToken {
    const isCancellationRequested = () => this.#isCancellationRequested(record);
    return {
      get isCancellationRequested() {
        return isCancellationRequested();
      },
      throwIfCancellationRequested() {
        if (isCancellationRequested()) {
          throw new Error('Export cancellation requested.');
        }
        record.externalCancellation?.throwIfCancellationRequested();
      },
    };
  }

  #set(record: JobRecord, state: ExportJobState, progress: number, error: AppError | null): void {
    const stateChanged = record.update.job.state !== state;
    record.update = {
      job: { ...record.update.job, state, progress },
      error,
    };
    this.#publish(record);
    if (stateChanged) {
      void this.#schedulePersistence();
    }
  }

  #schedulePersistence(): Promise<Result<void>> {
    const store = this.#deps.jobStore;
    if (store === undefined) {
      this.#trimHistory();
      return Promise.resolve(ok(undefined));
    }
    const pending = this.#persistTail.then(async () => {
      try {
        const entries = this.#retainedHistory().map(({ prepared, update }) => ({
          prepared,
          update,
        }));
        const saved = await store.save(entries);
        if (saved.ok) {
          this.#trimHistory();
        }
        return saved;
      } catch {
        return err(this.#error('export.persistence-failed'));
      }
    });
    this.#persistTail = pending;
    return pending;
  }

  #trimHistory(): boolean {
    const retained = new Set(this.#retainedHistory());
    const removed = [...this.#jobs.values()].filter(
      (record) => isTerminal(record.update.job.state) && !retained.has(record),
    );
    for (const record of removed) {
      this.#jobs.delete(record.update.job.id);
      this.#exportJobIds.delete(record.prepared.job.id);
    }
    return removed.length > 0;
  }

  #hasExcessHistory(): boolean {
    return (
      [...this.#jobs.values()].filter(({ update }) => isTerminal(update.job.state)).length >
      this.#maxHistoryEntries
    );
  }

  #retainedHistory(): JobRecord[] {
    const terminal = [...this.#jobs.values()]
      .filter(({ update }) => isTerminal(update.job.state))
      .sort((first, second) => first.update.job.createdAtUs - second.update.job.createdAtUs);
    const removeCount = Math.max(0, terminal.length - this.#maxHistoryEntries);
    const removed = new Set(terminal.slice(0, removeCount));
    return [...this.#jobs.values()].filter((record) => !removed.has(record));
  }

  #flushPersistence(): Promise<Result<void>> {
    return this.#persistTail;
  }

  #serializeMutation<Value>(operation: () => Promise<Value>): Promise<Value> {
    const result = this.#mutationTail.then(operation, operation);
    this.#mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #publish(record: JobRecord): void {
    for (const listener of this.#listeners) {
      listener(record.update);
    }
  }

  #error(code: string): AppError {
    return createAppError({
      category: 'export',
      code,
      retryable: false,
      userMessageKey: `errors.${code}`,
      correlationId: this.#deps.createCorrelationId(),
    });
  }
}
