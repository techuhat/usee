import type {
  HostMergedRecording,
  HostSessionSummary,
  InterruptedRecording,
  RecoveredRecording,
  Result,
} from '@usee/contracts';

export interface ImportedRecording {
  readonly projectPath: string;
  readonly durationUs: number;
}

/**
 * Staged recordings and the projects they become. The filesystem adapter owns
 * the staging root, journal parsing and atomic project writes.
 */
export interface RecordingStorePort {
  /** Moves a session's merged recording, and its waveform, into a new project bundle. */
  importMergedSession(
    sessionId: string,
    merged: HostMergedRecording,
  ): Promise<Result<ImportedRecording>>;
  /** Moves a finished session's segments into a new project bundle, one clip each. */
  importSession(sessionId: string, summary: HostSessionSummary): Promise<Result<ImportedRecording>>;
  /** Staged sessions that were never imported, except `activeSessionId`. */
  listInterrupted(activeSessionId?: string): Promise<Result<readonly InterruptedRecording[]>>;
  /** Imports the journaled segments of an interrupted session. */
  recoverSession(sessionId: string): Promise<Result<RecoveredRecording>>;
  /** Deletes an interrupted session's staged files. */
  discardSession(sessionId: string): Promise<Result<void>>;
}
