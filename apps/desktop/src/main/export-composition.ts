import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  ExportCoordinator,
  compileRenderPlan,
  prepareExportJob,
  type PreparedExportJob,
} from '@usee/application';
import { createExportArtifactPublisher, createExportJobStore } from '@usee/adapter-project-fs';
import {
  createFfmpegExportWorker,
  hashRenderPlan,
  probeFfmpegCapabilities,
  verifyFfmpegRuntime,
  type FfmpegCapabilities,
} from '@usee/adapter-ffmpeg';
import {
  asJobId,
  asTimestampUs,
  createAppError,
  err,
  ok,
  type ExportFrameContextDto,
  type ExportFrameRequestDto,
  type ExportJobStatusDto,
  type ExportQueueViewDto,
  type ExportRuntimeStatusDto,
  type CorrelationId,
  type JobId,
  type QueueExportRequestDto,
  type Result,
} from '@usee/contracts';
import { EXPORT_PRESETS, type ExportJob } from '@usee/domain';

import type { Projects } from './project-composition';
import { RendererExportFrameSource } from './export-frame-source';
import type { ExportRuntimeSource } from './export-runtime-source';

export interface ExportCompositionOptions {
  readonly projects: Projects;
  /** Where FFmpeg comes from, and what vouches for it (resolveExportRuntimeSource). */
  readonly runtimeSource: ExportRuntimeSource;
  readonly userDataDirectory: string;
  readonly videosDirectory: string;
  readonly createCorrelationId: () => CorrelationId;
  readonly chooseDestination: (defaultPath: string) => Promise<string | undefined>;
  readonly reportDestinationExists: () => Promise<void>;
  readonly sendFrameRequest: (request: ExportFrameRequestDto) => boolean | void;
  readonly publishStatus: (status: ExportJobStatusDto) => void;
}

export interface Exports {
  initialize(): Promise<Result<void>>;
  getQueue(): ExportQueueViewDto;
  queue(request: QueueExportRequestDto): Promise<Result<ExportJobStatusDto | null>>;
  cancel(renderJobId: JobId): Promise<Result<null>>;
  frameContext(exportJobId: JobId): Promise<Result<ExportFrameContextDto>>;
  submitFrame(exportJobId: JobId, requestId: string, frame: Uint8Array | null): Result<null>;
  shutdown(): Promise<void>;
}

function appError(code: string, correlationId: CorrelationId) {
  return createAppError({
    category: 'export',
    code,
    retryable: false,
    userMessageKey: `errors.${code}`,
    correlationId,
  });
}

function statusOf(update: {
  readonly job: ExportJobStatusDto['job'];
  readonly error: ExportJobStatusDto['error'];
}): ExportJobStatusDto {
  return { job: update.job, error: update.error };
}

function safeFileStem(title: string): string {
  return (
    Array.from(title, (character) => {
      const code = character.charCodeAt(0);
      return /[<>:"/\\|?*]/.test(character) || code < 32 || (code >= 127 && code <= 159)
        ? '-'
        : character;
    })
      .join('')
      .replace(/[ .]+$/g, '')
      .slice(0, 100) || 'usee-export'
  );
}

function isTerminal(state: ExportJobStatusDto['job']['state']): boolean {
  return state === 'succeeded' || state === 'canceled' || state === 'failed';
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw cause;
  }
}

export async function composeExports(options: ExportCompositionOptions): Promise<Exports> {
  const createCorrelationId = options.createCorrelationId;
  const frameSource = new RendererExportFrameSource({
    send: options.sendFrameRequest,
    createCorrelationId,
  });
  const workRoot = path.join(options.userDataDirectory, 'exports');
  const jobStore = createExportJobStore({
    filePath: path.join(options.userDataDirectory, 'export-queue.json'),
    createCorrelationId,
  });
  const publisher = createExportArtifactPublisher({ workRoot, createCorrelationId });

  let runtime: Awaited<ReturnType<typeof verifyFfmpegRuntime>> = err(
    appError('export.ffmpeg-runtime-missing', createCorrelationId()),
  );
  let capabilities: FfmpegCapabilities | undefined;
  try {
    const source = options.runtimeSource;
    const bytes = await readFile(
      path.join(source.resourcesDirectory, 'ffmpeg', source.manifestFileName),
    );
    runtime = await verifyFfmpegRuntime(
      source.resourcesDirectory,
      bytes,
      source.trust.kind === 'anchor'
        ? source.trust.sha256
        : createHash('sha256').update(bytes).digest('hex'),
      createCorrelationId(),
    );
    if (runtime.ok) {
      const probed = await probeFfmpegCapabilities(runtime.value, createCorrelationId());
      if (probed.ok) {
        capabilities = probed.value;
      } else {
        runtime = err(probed.error);
      }
    }
  } catch {
    // A development build without the approved, bundled runtime keeps export unavailable.
  }

  const videoEncoders = capabilities?.videoEncoders ?? [];
  const audioEncoders = capabilities?.audioEncoders ?? [];
  const runtimeStatus: ExportRuntimeStatusDto = {
    available: runtime.ok && videoEncoders.includes('h264_mf') && audioEncoders.includes('aac'),
    videoEncoders,
    audioEncoders,
    reason: runtime.ok
      ? videoEncoders.includes('h264_mf') && audioEncoders.includes('aac')
        ? null
        : 'export.encoder-unavailable'
      : runtime.error.code,
  };

  const worker =
    runtime.ok && capabilities !== undefined && runtimeStatus.available
      ? createFfmpegExportWorker({
          runtime: runtime.value,
          capabilities,
          frameSource,
          mediaPaths: {
            resolve: (projectId, assetIds) =>
              options.projects.resolveMediaAssets(projectId, assetIds),
          },
          publisher,
          workRoot,
          createCorrelationId,
        })
      : {
          run() {
            return Promise.resolve(
              err(
                appError(
                  runtimeStatus.reason ?? 'export.encoder-unavailable',
                  createCorrelationId(),
                ),
              ),
            );
          },
        };

  const coordinator = new ExportCoordinator({
    worker,
    hashPlan: hashRenderPlan,
    createRenderJobId: () => asJobId(randomUUID()),
    createCorrelationId,
    jobStore,
  });
  const preparedByExportId = new Map<JobId, PreparedExportJob>();
  const leases = new Map<JobId, () => void>();
  const contexts = new Map<JobId, ExportFrameContextDto>();
  const lastPublished = new Map<JobId, number>();
  let initialization: Promise<Result<void>> | undefined;

  const publish = (update: ExportJobStatusDto) => {
    const id = update.job.exportJobId;
    const now = Date.now();
    const prior = lastPublished.get(id) ?? 0;
    if (!isTerminal(update.job.state) && now - prior < 150) {
      return;
    }
    lastPublished.set(id, now);
    options.publishStatus(update);
    if (isTerminal(update.job.state)) {
      leases.get(id)?.();
      leases.delete(id);
      contexts.delete(id);
      preparedByExportId.delete(id);
      lastPublished.delete(id);
    }
  };

  coordinator.subscribe((update) => publish(statusOf(update)));

  const initialize = (): Promise<Result<void>> => {
    initialization ??= (async () => {
      const stored = await jobStore.load();
      if (!stored.ok) {
        return stored;
      }
      for (const entry of stored.value) {
        if (entry.update.job.state === 'queued') {
          preparedByExportId.set(entry.prepared.job.id, entry.prepared);
        }
      }
      const restored = await coordinator.initialize();
      if (!restored.ok) {
        return restored;
      }
      return ok(undefined);
    })();
    return initialization;
  };

  const currentUpdate = (exportJobId: JobId) =>
    coordinator.list().find((entry) => entry.job.exportJobId === exportJobId);

  return {
    initialize,
    getQueue() {
      return {
        runtime: runtimeStatus,
        jobs: coordinator.list().map(statusOf),
      };
    },
    async queue(request) {
      const initialized = await initialize();
      if (!initialized.ok) {
        return initialized;
      }
      if (!runtimeStatus.available) {
        return err(
          appError(runtimeStatus.reason ?? 'export.encoder-unavailable', createCorrelationId()),
        );
      }
      const project = options.projects.currentProject();
      if (project === null) {
        return err(appError('project.not-open', createCorrelationId()));
      }
      const preset = EXPORT_PRESETS[request.presetId];
      const validation = compileRenderPlan(project, request.presetId, createCorrelationId());
      if (!validation.ok) {
        return validation;
      }
      const saved = await options.projects.save();
      if (!saved.ok) {
        return saved;
      }
      const currentProject = options.projects.currentProject();
      if (currentProject === null) {
        return err(appError('project.not-open', createCorrelationId()));
      }
      const title = options.projects.current()?.title ?? 'usee-export';
      let suggestion = path.join(
        options.videosDirectory,
        `${safeFileStem(title)}-${preset.id}.mp4`,
      );
      let destinationPath: string | undefined;
      while (destinationPath === undefined) {
        const selected = await options.chooseDestination(suggestion);
        if (selected === undefined) {
          return ok(null);
        }
        const targetPath =
          path.extname(selected).toLowerCase() === '.mp4' ? selected : `${selected}.mp4`;
        const collision = await exists(targetPath).catch(() => undefined);
        if (collision === undefined) {
          return err(appError('export.destination-check-failed', createCorrelationId()));
        }
        if (!collision) {
          if (!path.isAbsolute(targetPath)) {
            return err(appError('export.destination-invalid', createCorrelationId()));
          }
          destinationPath = targetPath;
          break;
        }
        await options.reportDestinationExists();
        const parsed = path.parse(targetPath);
        let suffix = 2;
        do {
          suggestion = path.join(parsed.dir, `${parsed.name} (${suffix++})${parsed.ext}`);
        } while (await exists(suggestion));
      }

      const exportJob: ExportJob = {
        id: asJobId(randomUUID()),
        projectId: currentProject.id,
        state: 'queued',
        preset,
        destinationPath,
        createdAtUs: asTimestampUs(Date.now() * 1_000),
      };
      const prepared = prepareExportJob(
        currentProject,
        exportJob,
        createCorrelationId(),
        hashRenderPlan,
      );
      if (!prepared.ok) {
        return prepared;
      }
      preparedByExportId.set(exportJob.id, prepared.value);
      const queued = await coordinator.enqueue(prepared.value);
      if (!queued.ok) {
        preparedByExportId.delete(exportJob.id);
        return queued;
      }
      const update = currentUpdate(exportJob.id);
      return ok(update === undefined ? null : statusOf(update));
    },
    async cancel(renderJobId) {
      const canceled = await coordinator.cancel(renderJobId);
      return canceled.ok ? ok(null) : canceled;
    },
    async frameContext(exportJobId) {
      const initialized = await initialize();
      if (!initialized.ok) {
        return initialized;
      }
      const update = currentUpdate(exportJobId);
      const prepared = preparedByExportId.get(exportJobId);
      if (prepared === undefined || update === undefined || update.job.state !== 'rendering') {
        return err(appError('export.job-not-found', createCorrelationId()));
      }
      const cached = contexts.get(exportJobId);
      if (cached !== undefined) {
        return ok(cached);
      }
      const videoIds = prepared.plan.assets
        .filter((asset) => asset.kind === 'video')
        .map((asset) => asset.id);
      if (!leases.has(exportJobId)) {
        const lease = await options.projects.acquireMediaLease(prepared.plan.projectId, videoIds);
        if (!lease.ok) {
          return lease;
        }
        leases.set(exportJobId, lease.value.release);
        const pointerIds = prepared.plan.tracks.flatMap((track) =>
          track.clips.flatMap((clip) =>
            clip.pointer === null ? [] : [clip.pointer.streamAssetId],
          ),
        );
        const pointerTracks = await options.projects.readPointerTracks(
          prepared.plan.projectId,
          pointerIds,
        );
        if (!pointerTracks.ok) {
          lease.value.release();
          leases.delete(exportJobId);
          return pointerTracks;
        }
        const context: ExportFrameContextDto = {
          plan: prepared.plan as unknown as ExportFrameContextDto['plan'],
          mediaUrls: lease.value.mediaUrls,
          pointerTracks: pointerTracks.value,
        };
        contexts.set(exportJobId, context);
        return ok(context);
      }
      return err(appError('export.job-not-found', createCorrelationId()));
    },
    submitFrame(exportJobId, requestId, frame) {
      const submitted = frameSource.submit(exportJobId, requestId, frame);
      return submitted.ok ? ok(null) : submitted;
    },
    async shutdown() {
      if (initialization === undefined) {
        return;
      }
      const initialized = await initialize();
      if (!initialized.ok) {
        return;
      }
      const pending = coordinator.list().filter(({ job }) => !isTerminal(job.state));
      await Promise.all(pending.map(({ job }) => coordinator.cancel(job.id)));
      const deadline = Date.now() + 20_000;
      while (
        Date.now() < deadline &&
        coordinator.list().some(({ job }) => !isTerminal(job.state))
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      for (const release of leases.values()) {
        release();
      }
      leases.clear();
    },
  };
}
