import {
  createAppError,
  err,
  hostErrorToAppError,
  ok,
  type AppError,
  type CaptureSource,
  type CorrelationId,
  type ErrorCategory,
  type HostDisplay,
  type HostSessionSummary,
  type InterruptedRecording,
  type RecordingSessionId,
  type RecordingSources,
  type RecordingState,
  type RecoveredRecording,
  type Result,
  type StartRecordingRequest,
} from '@usee/contracts';
import {
  IDLE_RECORDING,
  nextRecordingState,
  type RecordingLifecycle,
  type RecordingLifecycleEvent,
} from '@usee/domain';

import type { RecorderHostEvent, RecorderHostPort } from './recorder-host-port';
import type { ImportedRecording, RecordingStorePort } from './recording-store-port';

export interface RecordingServiceDependencies {
  readonly host: RecorderHostPort;
  readonly store: RecordingStorePort;
  readonly createSessionId: () => RecordingSessionId;
  readonly createCorrelationId: () => CorrelationId;
  readonly now: () => Date;
  /** Segment length passed to the host. */
  readonly segmentDurationMs?: number;
}

/** How the host is asked for a source (recorder protocol 1.3); a display is its default. */
function hostSource(source: CaptureSource) {
  switch (source.kind) {
    case 'display':
      return { displayId: source.displayId };
    case 'window':
      return { sourceKind: 'window', windowId: source.windowId } as const;
    case 'region':
      return { sourceKind: 'region', displayId: source.displayId, region: source.region } as const;
  }
}

/**
 * Owns the recording lifecycle (docs/module-boundaries.md, "Recording
 * coordinator"). The renderer only ever sees the `RecordingState` projection.
 */
export class RecordingService {
  readonly #deps: RecordingServiceDependencies;
  readonly #listeners = new Set<(state: RecordingState) => void>();
  #lifecycle: RecordingLifecycle = IDLE_RECORDING;
  #state: RecordingState = { phase: 'idle' };
  #finalizing: Promise<Result<RecordingState>> | undefined;

  constructor(dependencies: RecordingServiceDependencies) {
    this.#deps = dependencies;
    dependencies.host.subscribe((event) => this.#onHostEvent(event));
  }

  get state(): RecordingState {
    return this.#state;
  }

  /** Returns a function that removes the listener. */
  subscribe(listener: (state: RecordingState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The displays alone, for the area picker. */
  listDisplays(): Promise<Result<readonly HostDisplay[]>> {
    return this.#deps.host.listDisplays();
  }

  async listSources(): Promise<Result<RecordingSources>> {
    const displays = await this.#deps.host.listDisplays();
    if (!displays.ok) {
      return displays;
    }
    const windows = await this.#deps.host.listWindows();
    if (!windows.ok) {
      return windows;
    }
    const audioInputs = await this.#deps.host.listAudioInputs();
    if (!audioInputs.ok) {
      return audioInputs;
    }
    return ok({ displays: displays.value, windows: windows.value, audioInputs: audioInputs.value });
  }

  async start(request: StartRecordingRequest): Promise<Result<RecordingState>> {
    const sessionId = this.#deps.createSessionId();
    if (!this.#apply({ type: 'prepare', sessionId })) {
      return err(this.#error('capture', 'capture.session-active'));
    }
    this.#publish({ phase: 'preparing', sessionId });

    const started = await this.#deps.host.startSession({
      sessionId,
      ...hostSource(request.source),
      frameRateNumerator: request.frameRate,
      frameRateDenominator: 1,
      // A recorded pointer is drawn by the editor, so the video leaves the OS cursor out.
      includeCursor: request.trackPointer ? false : request.includeCursor,
      trackPointer: request.trackPointer,
      segmentDurationMs: this.#deps.segmentDurationMs ?? 10_000,
      audioInputId: request.audioInputId,
    });
    if (!started.ok) {
      this.#fail(started.error, null);
      return err(started.error);
    }

    // The host may already have reported a failure while we awaited the reply.
    if (!this.#apply({ type: 'started' })) {
      return ok(this.#state);
    }
    this.#publish({
      phase: 'recording',
      sessionId,
      startedAt: this.#deps.now().toISOString(),
      metrics: { elapsedUs: 0, framesEncoded: 0, framesDropped: 0 },
      microphone: started.value.audio === null ? 'off' : 'on',
      hardwareEncoder: started.value.video.hardwareEncoder,
    });
    return ok(this.#state);
  }

  /** Stops and imports the active recording. Calling it again while finalizing is a no-op. */
  stop(): Promise<Result<RecordingState>> {
    if (this.#finalizing !== undefined) {
      return this.#finalizing;
    }
    if (this.#lifecycle.phase !== 'recording') {
      return Promise.resolve(err(this.#error('capture', 'capture.session-not-active')));
    }
    return this.#finalize(undefined);
  }

  listInterrupted(): Promise<Result<readonly InterruptedRecording[]>> {
    return this.#deps.store.listInterrupted(this.#activeSessionId());
  }

  recover(sessionId: string): Promise<Result<RecoveredRecording>> {
    if (sessionId === this.#activeSessionId()) {
      return Promise.resolve(err(this.#error('capture', 'capture.session-active')));
    }
    return this.#recover(sessionId);
  }

  discard(sessionId: string): Promise<Result<void>> {
    if (sessionId === this.#activeSessionId()) {
      return Promise.resolve(err(this.#error('capture', 'capture.session-active')));
    }
    return this.#deps.store.discardSession(sessionId);
  }

  #finalize(failure: AppError | undefined): Promise<Result<RecordingState>> {
    const finalizing = this.#runFinalize(failure).finally(() => {
      this.#finalizing = undefined;
    });
    this.#finalizing = finalizing;
    return finalizing;
  }

  async #runFinalize(failure: AppError | undefined): Promise<Result<RecordingState>> {
    if (this.#lifecycle.phase !== 'recording') {
      return ok(this.#state);
    }
    const { sessionId } = this.#lifecycle;
    this.#apply({ type: 'stop' });
    this.#publish({ phase: 'finalizing', sessionId });

    const summary = await this.#deps.host.stopSession(sessionId);
    if (!summary.ok) {
      // The journal and segments stay staged; recovery can import them later.
      this.#fail(summary.error, null);
      return err(summary.error);
    }
    const imported = await this.#importFinished(sessionId, summary.value);
    if (!imported.ok) {
      this.#fail(imported.error, null);
      return err(imported.error);
    }

    const hostFailure =
      summary.value.failure === null
        ? undefined
        : hostErrorToAppError(summary.value.failure, this.#deps.createCorrelationId());
    const recordingFailure = failure ?? hostFailure;
    if (recordingFailure !== undefined) {
      // What was recorded before the failure is saved; the state says both.
      this.#fail(recordingFailure, imported.value.projectPath);
      return ok(this.#state);
    }

    this.#apply({ type: 'finalized' });
    this.#publish({
      phase: 'completed',
      sessionId,
      projectPath: imported.value.projectPath,
      durationUs: summary.value.durationUs,
      framesDropped: summary.value.framesDropped,
    });
    return ok(this.#state);
  }

  /**
   * Merges the session into one recording and imports it. When the merge fails
   * (a full disk, segments from two encoders) the segments are imported as
   * one clip each instead; the host logs the reason.
   */
  async #importFinished(
    sessionId: string,
    summary: HostSessionSummary,
  ): Promise<Result<ImportedRecording>> {
    const merged = await this.#deps.host.mergeSession(sessionId, { verifyHashes: false });
    return merged.ok
      ? this.#deps.store.importMergedSession(sessionId, merged.value)
      : this.#deps.store.importSession(sessionId, summary);
  }

  /** As #importFinished, but the merge first re-checks every segment's hash. */
  async #recover(sessionId: string): Promise<Result<RecoveredRecording>> {
    const merged = await this.#deps.host.mergeSession(sessionId, { verifyHashes: true });
    if (!merged.ok) {
      return this.#deps.store.recoverSession(sessionId);
    }
    const imported = await this.#deps.store.importMergedSession(sessionId, merged.value);
    return imported.ok ? ok({ sessionId, ...imported.value }) : imported;
  }

  #onHostEvent(event: RecorderHostEvent): void {
    const state = this.#state;
    switch (event.type) {
      case 'metrics':
        if (state.phase === 'recording' && state.sessionId === event.sessionId) {
          this.#publish({ ...state, metrics: event.metrics });
        }
        return;
      case 'stream-failed':
        if (
          state.phase === 'recording' &&
          state.sessionId === event.sessionId &&
          event.stream === 'audio'
        ) {
          this.#publish({ ...state, microphone: 'failed' });
        }
        return;
      case 'session-failed':
        if (state.phase === 'recording' && state.sessionId === event.sessionId) {
          void this.#finalize(event.error);
        }
        return;
      case 'host-lost':
        // A finalize in progress sees its own request fail, and falls back.
        if (this.#lifecycle.phase !== 'finalizing') {
          this.#fail(event.error, null);
        }
        return;
    }
  }

  #fail(error: AppError, projectPath: string | null): void {
    const sessionId = this.#activeSessionId();
    if (!this.#apply({ type: 'fail' })) {
      return; // nothing active, or already failed
    }
    this.#publish({ phase: 'failed', sessionId: sessionId ?? null, error, projectPath });
  }

  #activeSessionId(): string | undefined {
    return this.#lifecycle.phase === 'idle' ? undefined : this.#lifecycle.sessionId;
  }

  #apply(event: RecordingLifecycleEvent): boolean {
    const next = nextRecordingState(this.#lifecycle, event);
    if (next === undefined || next === this.#lifecycle) {
      return false;
    }
    this.#lifecycle = next;
    return true;
  }

  #publish(state: RecordingState): void {
    this.#state = state;
    for (const listener of this.#listeners) {
      listener(state);
    }
  }

  #error(category: ErrorCategory, code: string): AppError {
    return createAppError({
      category,
      code,
      retryable: false,
      userMessageKey: `errors.${code}`,
      correlationId: this.#deps.createCorrelationId(),
    });
  }
}
