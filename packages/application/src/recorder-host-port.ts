import type {
  AppError,
  HostAudioInput,
  HostDisplay,
  HostMergedRecording,
  HostSessionSummary,
  HostWindow,
  RecorderParams,
  RecorderResult,
  RecordingMetrics,
  Result,
} from '@usee/contracts';

/** Notifications from the native recorder host, already validated and mapped. */
export type RecorderHostEvent =
  | { readonly type: 'metrics'; readonly sessionId: string; readonly metrics: RecordingMetrics }
  | {
      readonly type: 'stream-failed';
      readonly sessionId: string;
      readonly stream: 'video' | 'audio';
      readonly error: AppError;
    }
  | { readonly type: 'session-failed'; readonly sessionId: string; readonly error: AppError }
  /** The host process exited without being asked to. */
  | { readonly type: 'host-lost'; readonly error: AppError };

/**
 * The native recorder host as the application sees it. The adapter owns the
 * process: it launches it on first use and again after a crash.
 */
export interface RecorderHostPort {
  listDisplays(): Promise<Result<readonly HostDisplay[]>>;
  /** The windows a user may choose; their titles are for the picker only (ADR-009). */
  listWindows(): Promise<Result<readonly HostWindow[]>>;
  listAudioInputs(): Promise<Result<readonly HostAudioInput[]>>;
  startSession(
    params: RecorderParams<'startSession'>,
  ): Promise<Result<RecorderResult<'startSession'>>>;
  stopSession(sessionId: string): Promise<Result<HostSessionSummary>>;
  /**
   * Joins a finished session's journaled segments into one MP4 and derives its
   * waveform. `verifyHashes` re-checks every segment, for recovery.
   */
  mergeSession(
    sessionId: string,
    options: { readonly verifyHashes: boolean },
  ): Promise<Result<HostMergedRecording>>;
  /** Returns a function that removes the listener. */
  subscribe(listener: (event: RecorderHostEvent) => void): () => void;
}
