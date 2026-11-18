import { randomUUID } from 'node:crypto';

import type { ExportFrameSourcePort } from '@usee/application';
import {
  createAppError,
  err,
  ok,
  type CancellationToken,
  type CorrelationId,
  type ExportFrameRequestDto,
  type JobId,
  type Result,
} from '@usee/contracts';
import type { ExportJob, RenderPlan } from '@usee/domain';

type PendingFrames = Map<string, (frame: Result<Uint8Array>) => void>;

const MAX_FRAMES = 1_000_000;
const FRAME_RESPONSE_TIMEOUT_MS = 30_000;
/**
 * Frames asked for ahead of the one FFmpeg is reading: the renderer finds and
 * composes the next while this one is written, instead of waiting for it.
 */
const FRAMES_AHEAD = 2;

/**
 * Renderer bridge with a small lookahead: at most FRAMES_AHEAD requests are
 * outstanding, each answered by its own request ID, and frames reach FFmpeg
 * in order; the FFmpeg input callback supplies backpressure.
 */
export class RendererExportFrameSource implements ExportFrameSourcePort {
  readonly #send: (request: ExportFrameRequestDto) => boolean | void;
  readonly #createCorrelationId: () => CorrelationId;
  /** Each running job's outstanding requests, by request ID. */
  readonly #pending = new Map<string, PendingFrames>();

  constructor(options: {
    readonly send: (request: ExportFrameRequestDto) => boolean | void;
    readonly createCorrelationId: () => CorrelationId;
  }) {
    this.#send = options.send;
    this.#createCorrelationId = options.createCorrelationId;
  }

  async stream(
    job: ExportJob,
    plan: RenderPlan,
    cancellation: CancellationToken,
    writeFrame: (frame: Uint8Array, progress: number) => Promise<void>,
  ): Promise<Result<void>> {
    const { numerator, denominator } = plan.preset.frameRate;
    const count = Math.ceil((plan.durationUs * numerator) / (1_000_000 * denominator));
    if (!Number.isSafeInteger(count) || count <= 0 || count > MAX_FRAMES) {
      return this.#failure('export.plan-too-complex');
    }
    const pending: PendingFrames = new Map();
    this.#pending.set(job.id, pending);
    const asked: { readonly requestId: string; readonly received: Promise<Result<Uint8Array>> }[] =
      [];
    let nextIndex = 0;
    /** Fills the lookahead; false when the renderer could not be told. */
    const askAhead = (): boolean => {
      while (asked.length < FRAMES_AHEAD && nextIndex < count) {
        const frameIndex = nextIndex;
        nextIndex += 1;
        const requestId = randomUUID();
        const timelineUs = Math.floor((frameIndex * 1_000_000 * denominator) / numerator);
        const received = new Promise<Result<Uint8Array>>((resolve) => {
          pending.set(requestId, resolve);
        });
        if (this.#send({ exportJobId: job.id, requestId, frameIndex, timelineUs }) === false) {
          return false;
        }
        asked.push({ requestId, received });
      }
      return true;
    };
    try {
      for (let frameIndex = 0; frameIndex < count; frameIndex += 1) {
        cancellation.throwIfCancellationRequested();
        const head = askAhead() ? asked.shift() : undefined;
        if (head === undefined) {
          return this.#failure('export.render-failed');
        }
        const frame = await this.#waitForFrame(pending, head, cancellation);
        if (!frame.ok) {
          return frame;
        }
        // The next frames are asked for before this one is written, so both happen at once.
        if (!askAhead()) {
          return this.#failure('export.render-failed');
        }
        await writeFrame(frame.value, (frameIndex + 1) / count);
      }
      return ok(undefined);
    } catch {
      return cancellation.isCancellationRequested
        ? this.#failure('export.canceled')
        : this.#failure('export.render-failed');
    } finally {
      this.#pending.delete(job.id);
      for (const resolve of pending.values()) {
        resolve(this.#failure('export.canceled'));
      }
      pending.clear();
    }
  }

  submit(exportJobId: JobId, requestId: string, frame: Uint8Array | null): Result<void> {
    const pending = this.#pending.get(exportJobId);
    const resolve = pending?.get(requestId);
    if (pending === undefined || resolve === undefined) {
      return this.#failure('export.frame-invalid');
    }
    pending.delete(requestId);
    resolve(frame === null ? this.#failure('export.render-failed') : ok(new Uint8Array(frame)));
    return ok(undefined);
  }

  #waitForFrame(
    pending: PendingFrames,
    request: { readonly requestId: string; readonly received: Promise<Result<Uint8Array>> },
    cancellation: CancellationToken,
  ): Promise<Result<Uint8Array>> {
    const { requestId, received } = request;
    return new Promise((resolve) => {
      const finish = (frame: Result<Uint8Array>) => {
        clearInterval(cancellationTimer);
        clearTimeout(timeout);
        resolve(frame);
      };
      const timer = setInterval(() => {
        if (!cancellation.isCancellationRequested) {
          return;
        }
        clearInterval(timer);
        const resolve = pending.get(requestId);
        pending.delete(requestId);
        const canceled = this.#failure('export.canceled');
        resolve?.(canceled);
        finish(canceled);
      }, 100);
      const cancellationTimer = timer;
      const timeout = setTimeout(() => {
        const resolve = pending.get(requestId);
        pending.delete(requestId);
        const timedOut = this.#failure('export.renderer-timeout');
        resolve?.(timedOut);
        finish(timedOut);
      }, FRAME_RESPONSE_TIMEOUT_MS);
      void received.then(finish, () => finish(this.#failure('export.render-failed')));
    });
  }

  #failure(code: string): Result<never> {
    const correlationId = this.#createCorrelationId();
    return err(
      createAppError({
        category: 'export',
        code,
        retryable: code === 'export.render-failed',
        userMessageKey: `errors.${code}`,
        correlationId,
      }),
    );
  }
}
