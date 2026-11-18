import { describe, expect, it, vi } from 'vitest';

import {
  asAssetId,
  asCorrelationId,
  asClipId,
  asDurationUs,
  asJobId,
  asProjectId,
  asTrackId,
  asTimestampUs,
  createAppError,
  err,
  ok,
} from '@usee/contracts';
import {
  DEFAULT_AUTO_ZOOM_SETTINGS,
  DEFAULT_CANVAS_STYLE,
  DEFAULT_CURSOR_SETTINGS,
  EXPORT_PRESETS,
  type ExportJob,
  type RenderPlan,
} from '@usee/domain';

import { ExportCoordinator } from './export-coordinator';
import type {
  ExportJobStorePort,
  ExportWorkerPort,
  PersistedExportJob,
  PreparedExportJob,
} from './export-ports';

const PLAN_HASH = 'a'.repeat(64);

function exportJob(id: string): ExportJob {
  return {
    id: asJobId(id),
    projectId: asProjectId('project-1'),
    state: 'queued',
    preset: {
      ...EXPORT_PRESETS['mp4-h264-1080p30'],
      dimensions: { ...EXPORT_PRESETS['mp4-h264-1080p30'].dimensions },
      frameRate: { ...EXPORT_PRESETS['mp4-h264-1080p30'].frameRate },
    },
    destinationPath: `C:/exports/${id}.mp4`,
    createdAtUs: asTimestampUs(1_000),
  };
}

function preparedExportJob(id: string): PreparedExportJob {
  const job = exportJob(id);
  const assetId = asAssetId(`${id}-asset`);
  const plan: RenderPlan = {
    planVersion: 1,
    projectId: job.projectId,
    projectUpdatedAtUs: asTimestampUs(500),
    durationUs: 1_000_000,
    frameRate: { numerator: 30, denominator: 1 },
    preset: job.preset,
    assets: [
      {
        id: assetId,
        kind: 'video',
        durationUs: asDurationUs(1_000_000),
        dimensions: { width: 1920, height: 1080 },
        frameRate: { numerator: 30, denominator: 1 },
        hasAudio: false,
      },
    ],
    tracks: [
      {
        id: asTrackId(`${id}-track`),
        kind: 'video',
        muted: false,
        clips: [
          {
            id: asClipId(`${id}-clip`),
            assetId,
            sourceStartUs: 0,
            sourceDurationUs: 1_000_000,
            timelineStartUs: 0,
            timelineDurationUs: 1_000_000,
            speed: 1,
            effects: [],
            pointer: null,
          },
        ],
      },
    ],
    analysisRuns: [],
    canvas: DEFAULT_CANVAS_STYLE,
    cursor: DEFAULT_CURSOR_SETTINGS,
    autoZoom: DEFAULT_AUTO_ZOOM_SETTINGS,
  };
  return { job, plan, planHash: PLAN_HASH };
}

function coordinator(
  worker: ExportWorkerPort,
  jobStore?: ExportJobStorePort,
  maxHistoryEntries?: number,
): ExportCoordinator {
  let nextId = 0;
  return new ExportCoordinator({
    worker,
    hashPlan: () => PLAN_HASH,
    createRenderJobId: () => asJobId(`render-${++nextId}`),
    createCorrelationId: () => asCorrelationId('export-test'),
    ...(jobStore === undefined ? {} : { jobStore }),
    ...(maxHistoryEntries === undefined ? {} : { maxHistoryEntries }),
  });
}

function stateOf(service: ExportCoordinator, renderJobId: ReturnType<typeof asJobId>) {
  const result = service.get(renderJobId);
  return result.ok ? result.value.job.state : undefined;
}

function complete(update: Parameters<ExportWorkerPort['run']>[4]): void {
  update('rendering', 0.4);
  update('validating', 0.8);
  update('publishing', 0.95);
}

describe('ExportCoordinator', () => {
  it('runs jobs serially and publishes valid lifecycle progress', async () => {
    let releaseFirst: (() => void) | undefined;
    const runOrder: string[] = [];
    const worker: ExportWorkerPort = {
      run(job, _plan, _planHash, _cancellation, update) {
        runOrder.push(job.id);
        if (job.id === 'export-1') {
          update('rendering', 0.25);
          return new Promise((resolve) => {
            releaseFirst = () => {
              complete(update);
              resolve(ok(undefined));
            };
          });
        }
        complete(update);
        return Promise.resolve(ok(undefined));
      },
    };
    const service = coordinator(worker);
    const updates: string[] = [];
    service.subscribe(({ job }) => updates.push(`${job.exportJobId}:${job.state}`));

    const first = await service.enqueue(preparedExportJob('export-1'));
    const second = await service.enqueue(preparedExportJob('export-2'));

    expect(first.ok && first.value.state).toBe('queued');
    expect(second.ok && second.value.state).toBe('queued');
    expect(runOrder).toEqual(['export-1']);
    releaseFirst?.();

    await vi.waitFor(() => {
      expect(second.ok && stateOf(service, second.value.id)).toBe('succeeded');
    });
    expect(runOrder).toEqual(['export-1', 'export-2']);
    expect(updates).toContain('export-1:rendering');
    expect(updates).toContain('export-2:succeeded');
  });

  it('cancels a queued job without starting its worker', async () => {
    let releaseFirst: (() => void) | undefined;
    const run = vi.fn<ExportWorkerPort['run']>((_job, _plan, _planHash, _cancellation, update) => {
      update('rendering', 0.2);
      return new Promise((resolve) => {
        releaseFirst = () => {
          complete(update);
          resolve(ok(undefined));
        };
      });
    });
    const worker: ExportWorkerPort = { run };
    const service = coordinator(worker);
    const first = await service.enqueue(preparedExportJob('export-1'));
    const queued = await service.enqueue(preparedExportJob('export-2'));
    if (!queued.ok) {
      throw new Error('Expected queued job.');
    }

    expect((await service.cancel(queued.value.id)).ok).toBe(true);
    expect(service.get(queued.value.id)).toMatchObject({
      ok: true,
      value: { job: { state: 'canceled' } },
    });
    releaseFirst?.();
    await vi.waitFor(() => expect(first.ok && stateOf(service, first.value.id)).toBe('succeeded'));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('persists the queued request before allowing its worker to start', async () => {
    const saved: PersistedExportJob[][] = [];
    const jobStore: ExportJobStorePort = {
      load: () => Promise.resolve(ok([])),
      save(entries) {
        saved.push([...entries]);
        return Promise.resolve(ok(undefined));
      },
    };
    const worker: ExportWorkerPort = {
      run(_job, _plan, _planHash, _cancellation, update) {
        expect(saved.find((entries) => entries.length > 0)?.[0]?.update.job.state).toBe('queued');
        complete(update);
        return Promise.resolve(ok(undefined));
      },
    };
    const service = coordinator(worker, jobStore);

    const result = await service.enqueue(preparedExportJob('export-1'));
    if (!result.ok) throw new Error('Expected queued job.');

    await vi.waitFor(() => expect(stateOf(service, result.value.id)).toBe('succeeded'));
    expect(saved.some((entries) => entries[0]?.update.job.state === 'publishing')).toBe(true);
  });

  it('requeues queued jobs and fails active jobs after restart', async () => {
    const interrupted = preparedExportJob('export-interrupted');
    const queued = preparedExportJob('export-queued');
    const persisted: readonly PersistedExportJob[] = [
      {
        prepared: interrupted,
        update: {
          job: {
            id: asJobId('render-interrupted'),
            exportJobId: interrupted.job.id,
            state: 'rendering',
            progress: 0.4,
            createdAtUs: interrupted.job.createdAtUs,
          },
          error: null,
        },
      },
      {
        prepared: queued,
        update: {
          job: {
            id: asJobId('render-queued'),
            exportJobId: queued.job.id,
            state: 'queued',
            progress: 0,
            createdAtUs: queued.job.createdAtUs,
          },
          error: null,
        },
      },
    ];
    const runOrder: string[] = [];
    const jobStore: ExportJobStorePort = {
      load: () => Promise.resolve(ok(persisted)),
      save: () => Promise.resolve(ok(undefined)),
    };
    const worker: ExportWorkerPort = {
      run(job, _plan, _planHash, _cancellation, update) {
        runOrder.push(job.id);
        complete(update);
        return Promise.resolve(ok(undefined));
      },
    };
    const service = coordinator(worker, jobStore);

    expect((await service.initialize()).ok).toBe(true);
    expect(service.get(asJobId('render-interrupted'))).toMatchObject({
      ok: true,
      value: { job: { state: 'failed' }, error: { code: 'export.interrupted' } },
    });
    await vi.waitFor(() =>
      expect(service.get(asJobId('render-queued'))).toMatchObject({
        ok: true,
        value: { job: { state: 'succeeded' } },
      }),
    );
    expect(runOrder).toEqual(['export-queued']);
  });

  it('rejects a prepared job whose plan no longer matches its hash', async () => {
    const run = vi.fn<ExportWorkerPort['run']>(() => Promise.resolve(ok(undefined)));
    const service = coordinator({ run });
    const prepared = preparedExportJob('export-1');

    const result = await service.enqueue({ ...prepared, planHash: 'b'.repeat(64) });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'export.plan-hash-mismatch' },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps active cancellation cooperative until the worker reaches a boundary', async () => {
    let finishAtBoundary: (() => void) | undefined;
    let token: Parameters<ExportWorkerPort['run']>[3] | undefined;
    const worker: ExportWorkerPort = {
      run(_job, _plan, _planHash, cancellation, update) {
        token = cancellation;
        update('rendering', 0.2);
        return new Promise((resolve) => {
          finishAtBoundary = () => {
            try {
              cancellation.throwIfCancellationRequested();
              complete(update);
              resolve(ok(undefined));
            } catch {
              resolve(
                err(
                  createAppError({
                    category: 'export',
                    code: 'export.canceled',
                    retryable: false,
                    userMessageKey: 'errors.export.canceled',
                    correlationId: asCorrelationId('export-test'),
                  }),
                ),
              );
            }
          };
        });
      },
    };
    const service = coordinator(worker);
    const result = await service.enqueue(preparedExportJob('export-1'));
    if (!result.ok) {
      throw new Error('Expected export job.');
    }

    await service.cancel(result.value.id);
    expect(token?.isCancellationRequested).toBe(true);
    expect(service.get(result.value.id)).toMatchObject({
      ok: true,
      value: { job: { state: 'rendering' } },
    });
    finishAtBoundary?.();
    await vi.waitFor(() =>
      expect(service.get(result.value.id)).toMatchObject({
        ok: true,
        value: { job: { state: 'canceled' } },
      }),
    );
  });

  it('fails a worker that reports an invalid progress transition', async () => {
    const worker: ExportWorkerPort = {
      run(_job, _plan, _planHash, _cancellation, update) {
        update('publishing', 0.7);
        return Promise.resolve(ok(undefined));
      },
    };
    const service = coordinator(worker);
    const result = await service.enqueue(preparedExportJob('export-1'));
    if (!result.ok) {
      throw new Error('Expected export job.');
    }

    await vi.waitFor(() => {
      expect(service.get(result.value.id)).toMatchObject({
        ok: true,
        value: {
          job: { state: 'failed' },
          error: { code: 'export.worker-protocol' },
        },
      });
    });
  });

  it('retains typed worker failures for status readers', async () => {
    const error = createAppError({
      category: 'export',
      code: 'export.ffmpeg-probe-failed',
      retryable: false,
      userMessageKey: 'errors.export.ffmpeg-probe-failed',
      correlationId: asCorrelationId('export-test'),
    });
    const service = coordinator({
      run: () => Promise.resolve(err(error)),
    });
    const result = await service.enqueue(preparedExportJob('export-1'));
    if (!result.ok) {
      throw new Error('Expected export job.');
    }

    await vi.waitFor(() => {
      const status = service.get(result.value.id);
      expect(status).toMatchObject({
        ok: true,
        value: { job: { state: 'failed' }, error },
      });
    });
  });

  it('bounds terminal history without dropping queued work', async () => {
    const saved: PersistedExportJob[][] = [];
    const jobStore: ExportJobStorePort = {
      load: () => Promise.resolve(ok([])),
      save(entries) {
        saved.push([...entries]);
        return Promise.resolve(ok(undefined));
      },
    };
    const service = coordinator(
      {
        run(_job, _plan, _planHash, _cancellation, update) {
          complete(update);
          return Promise.resolve(ok(undefined));
        },
      },
      jobStore,
      1,
    );
    const first = await service.enqueue(preparedExportJob('export-1'));
    if (!first.ok) throw new Error('Expected first export job.');
    await vi.waitFor(() => expect(stateOf(service, first.value.id)).toBe('succeeded'));

    const second = await service.enqueue(preparedExportJob('export-2'));
    if (!second.ok) throw new Error('Expected second export job.');
    await vi.waitFor(() => expect(stateOf(service, second.value.id)).toBe('succeeded'));

    expect(service.get(first.value.id)).toMatchObject({
      ok: false,
      error: { code: 'export.job-not-found' },
    });
    expect(service.list().map(({ job }) => job.exportJobId)).toEqual(['export-2']);
    expect(saved.at(-1)?.map(({ prepared }) => prepared.job.id)).toEqual(['export-2']);
  });
});
