import { copyFile, mkdir, readdir, readFile, rmdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

import type { ImportedRecording, RecordingStorePort } from '@usee/application';
import {
  asRecordingSessionId,
  createAppError,
  err,
  isOpaqueId,
  MERGE_OUTPUT_FILE_NAMES,
  MERGED_RECORDING_FILE_NAME,
  ok,
  POINTER_FILE_NAME,
  SEGMENT_FILE_NAME_PATTERN,
  WAVEFORM_FILE_NAME,
  type AppError,
  type CorrelationId,
  type HostMergedRecording,
  type HostSegment,
  type InterruptedRecording,
  type ProjectId,
  type Result,
} from '@usee/contracts';
import {
  createRecordingProject,
  encodeManifest,
  MANIFEST_FILE_NAME,
  PROJECT_BUNDLE_DIRECTORIES,
  pointerStreamPath,
  PROJECT_BUNDLE_EXTENSION,
  recordingAssetId,
  sessionMediaDirectory,
  waveformPath,
  type RecordedSource,
  type RecordingMedia,
  type RecordingProjectLooks,
} from '@usee/project-format';

import { fileSize, moveFile, sha256File, writeFileAtomic } from './file-operations';
import { JOURNAL_FILE_NAME, parseJournal, type ParsedJournal } from './journal';

/** Written before the first segment moves, so an interrupted import resumes into the same bundle. */
const IMPORT_TARGET_FILE = 'import-target.json';

export interface RecordingStoreOptions {
  readonly stagingRoot: string;
  readonly projectsRoot: string;
  readonly now: () => Date;
  readonly createProjectId: () => ProjectId;
  readonly createCorrelationId: () => CorrelationId;
  /** Support-safe warnings: an event name and context without paths. */
  readonly onWarning?: (event: string, context: Readonly<Record<string, string | number>>) => void;
  /** The looks a new project starts with, read as each recording is imported. */
  readonly projectLooks?: () => RecordingProjectLooks | undefined;
}

class StoreError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
  ) {
    super(code);
  }
}

type ImportMode = 'finished' | 'recovery';

type SessionStarted = NonNullable<ParsedJournal['started']>;

interface ImportTarget {
  readonly staging: string;
  readonly started: SessionStarted;
  readonly source: RecordedSource;
  readonly captureLatencyUs: number | undefined;
  readonly projectDirectory: string;
  readonly mediaDirectory: string;
}

/** What the journal says was recorded; older journals all recorded a display. */
function recordedSourceOf(started: SessionStarted): RecordedSource {
  if (started.sourceKind === 'window') {
    if (started.windowId === undefined) {
      throw new StoreError('storage.journal-invalid');
    }
    return { kind: 'window', windowId: started.windowId };
  }
  if (started.sourceKind === 'region') {
    if (started.region === undefined) {
      throw new StoreError('storage.journal-invalid');
    }
    return { kind: 'region', region: started.region };
  }
  if (started.displayId === undefined) {
    throw new StoreError('storage.journal-invalid');
  }
  return { kind: 'display', displayId: started.displayId };
}

function errnoOf(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

function localTimestamp(date: Date): string {
  const two = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ` +
    `${two(date.getHours())}-${two(date.getMinutes())}-${two(date.getSeconds())}`
  );
}

/**
 * Staged recordings → project bundles (docs/project-format.md, "Recovery and
 * portability"). The merged recording (or, as a fallback, each segment) moves
 * into `media/originals/<session>/`, and the manifest is written last and
 * atomically, so a bundle with a manifest is always complete. Deletions name
 * exact files; nothing is removed recursively.
 */
export function createRecordingStore(options: RecordingStoreOptions): RecordingStorePort {
  const warn = options.onWarning ?? (() => undefined);

  function toAppError(error: unknown): AppError {
    const errno = errnoOf(error);
    const code =
      error instanceof StoreError
        ? error.code
        : errno === 'ENOSPC'
          ? 'storage.disk-full'
          : errno === 'EACCES' || errno === 'EPERM'
            ? 'storage.access-denied'
            : 'storage.import-failed';
    return createAppError({
      category: 'storage',
      code,
      retryable: error instanceof StoreError ? error.retryable : code === 'storage.disk-full',
      userMessageKey: `errors.${code}`,
      correlationId: options.createCorrelationId(),
      ...(errno === undefined ? {} : { diagnosticContext: { errno } }),
    });
  }

  async function guard<Value>(operation: () => Promise<Value>): Promise<Result<Value>> {
    try {
      return ok(await operation());
    } catch (error) {
      return err(toAppError(error));
    }
  }

  function stagingDirectory(sessionId: string): string {
    if (!isOpaqueId(sessionId)) {
      throw new StoreError('storage.invalid-session');
    }
    return path.join(options.stagingRoot, sessionId);
  }

  async function readSessionJournal(directory: string): Promise<ParsedJournal> {
    try {
      return parseJournal(await readFile(path.join(directory, JOURNAL_FILE_NAME), 'utf8'));
    } catch (error) {
      throw errnoOf(error) === 'ENOENT' ? new StoreError('storage.session-not-found') : error;
    }
  }

  async function createBundleDirectories(directory: string): Promise<void> {
    for (const child of PROJECT_BUNDLE_DIRECTORIES) {
      await mkdir(path.join(directory, ...child.split('/')), { recursive: true });
    }
  }

  function isProjectBundleInRoot(candidate: string): boolean {
    const relative = path.relative(path.resolve(options.projectsRoot), path.resolve(candidate));
    return (
      relative !== '' &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      !relative.includes(path.sep) &&
      relative.endsWith(PROJECT_BUNDLE_EXTENSION)
    );
  }

  async function createUniqueBundle(): Promise<string> {
    await mkdir(options.projectsRoot, { recursive: true });
    const base = `Recording ${localTimestamp(options.now())}`;
    for (let attempt = 1; attempt < 100; attempt += 1) {
      const name = attempt === 1 ? base : `${base} (${attempt})`;
      const directory = path.join(options.projectsRoot, `${name}${PROJECT_BUNDLE_EXTENSION}`);
      try {
        await mkdir(directory);
      } catch (error) {
        if (errnoOf(error) === 'EEXIST') {
          continue;
        }
        throw error;
      }
      await createBundleDirectories(directory);
      return directory;
    }
    throw new StoreError('storage.project-name-unavailable');
  }

  async function resolveImportTarget(staging: string): Promise<string> {
    const markerPath = path.join(staging, IMPORT_TARGET_FILE);
    let marker: unknown;
    try {
      marker = JSON.parse(await readFile(markerPath, 'utf8'));
    } catch {
      marker = undefined; // absent or unreadable: start a new bundle
    }
    if (
      typeof marker === 'object' &&
      marker !== null &&
      'projectDirectory' in marker &&
      typeof marker.projectDirectory === 'string' &&
      isProjectBundleInRoot(marker.projectDirectory)
    ) {
      await createBundleDirectories(marker.projectDirectory);
      return marker.projectDirectory;
    }
    const projectDirectory = await createUniqueBundle();
    await writeFileAtomic(markerPath, JSON.stringify({ projectDirectory }));
    return projectDirectory;
  }

  /** Deletes exactly the files the host and this store write, then the directory if empty. */
  async function removeStagedSession(staging: string): Promise<void> {
    for (const entry of await readdir(staging)) {
      if (
        SEGMENT_FILE_NAME_PATTERN.test(entry) ||
        MERGE_OUTPUT_FILE_NAMES.includes(entry) ||
        entry === POINTER_FILE_NAME ||
        entry === JOURNAL_FILE_NAME ||
        entry === IMPORT_TARGET_FILE
      ) {
        await unlink(path.join(staging, entry));
      }
    }
    try {
      await rmdir(staging);
    } catch {
      warn('recording.staging.not-empty', {});
    }
  }

  /** The staged session's journal, bundle and media directory, ready for files to move in. */
  async function beginImport(sessionId: string): Promise<ImportTarget> {
    const staging = stagingDirectory(sessionId);
    const journal = await readSessionJournal(staging);
    const started = journal.started;
    if (started === undefined) {
      throw new StoreError('storage.journal-invalid');
    }
    const source = recordedSourceOf(started);
    const projectDirectory = await resolveImportTarget(staging);
    const mediaDirectory = path.join(
      projectDirectory,
      ...sessionMediaDirectory(sessionId).split('/'),
    );
    await mkdir(mediaDirectory, { recursive: true });
    return {
      staging,
      started,
      source,
      captureLatencyUs: journal.captureLatencyUs,
      projectDirectory,
      mediaDirectory,
    };
  }

  /** Moves the pointer stream, if the session has one; true when the bundle then holds it. */
  async function importPointerStream(sessionId: string, target: ImportTarget): Promise<boolean> {
    const source = path.join(target.staging, POINTER_FILE_NAME);
    const destination = path.join(
      target.projectDirectory,
      ...pointerStreamPath(sessionId).split('/'),
    );
    if ((await fileSize(source)) !== undefined) {
      await moveFile(source, destination);
      return true;
    }
    return (await fileSize(destination)) !== undefined; // moved by an earlier attempt
  }

  /** Copies the journal, writes the manifest last and atomically, then clears staging. */
  async function completeImport(
    sessionId: string,
    target: ImportTarget,
    media: RecordingMedia,
  ): Promise<void> {
    const { staging, started, source, captureLatencyUs, projectDirectory } = target;
    const hasPointer = await importPointerStream(sessionId, target);
    const looks = options.projectLooks?.();
    await copyFile(
      path.join(staging, JOURNAL_FILE_NAME),
      path.join(projectDirectory, 'metadata', 'sessions', `${sessionId}.journal.ndjson`),
    );
    const manifest = createRecordingProject({
      projectId: options.createProjectId(),
      title: path.basename(projectDirectory, PROJECT_BUNDLE_EXTENSION),
      createdAtUs: options.now().getTime() * 1000,
      sessionId: asRecordingSessionId(sessionId),
      source,
      video: { width: started.video.width, height: started.video.height },
      frameRate: {
        numerator: started.video.frameRateNumerator,
        denominator: started.video.frameRateDenominator,
      },
      audio: started.audio,
      media,
      hasPointer,
      ...(captureLatencyUs === undefined ? {} : { captureLatencyUs }),
      metadata: {
        encoderName: started.video.encoderName,
        hardwareEncoder: started.video.hardwareEncoder,
      },
      ...(looks === undefined ? {} : { looks }),
    });
    const encoded = encodeManifest(manifest);
    if (!encoded.ok) {
      throw new StoreError('storage.manifest-invalid');
    }
    await writeFileAtomic(path.join(projectDirectory, MANIFEST_FILE_NAME), encoded.value);
    await removeStagedSession(staging);
  }

  async function importMerged(
    sessionId: string,
    merged: HostMergedRecording,
  ): Promise<ImportedRecording> {
    const target = await beginImport(sessionId);
    const source = path.join(target.staging, MERGED_RECORDING_FILE_NAME);
    const destination = path.join(target.mediaDirectory, MERGED_RECORDING_FILE_NAME);
    if ((await fileSize(source)) === merged.bytes) {
      await moveFile(source, destination);
    } else if ((await fileSize(destination)) !== merged.bytes) {
      // Neither staged nor moved by an earlier, interrupted import.
      throw new StoreError('storage.recording-missing');
    }

    if (merged.waveform !== null) {
      // Derived and rebuildable: the recording imports without it.
      const waveformSource = path.join(target.staging, WAVEFORM_FILE_NAME);
      const waveformDestination = path.join(
        target.projectDirectory,
        ...waveformPath(recordingAssetId(sessionId)).split('/'),
      );
      try {
        if ((await fileSize(waveformSource)) !== undefined) {
          await moveFile(waveformSource, waveformDestination);
        }
      } catch (error) {
        warn('recording.waveform.not-imported', { errno: errnoOf(error) ?? 'unknown' });
      }
    }

    await completeImport(sessionId, target, {
      kind: 'merged',
      durationUs: merged.durationUs,
      hasAudio: merged.hasAudio,
    });
    return { projectPath: target.projectDirectory, durationUs: merged.durationUs };
  }

  async function importSegments(
    sessionId: string,
    segments: readonly HostSegment[],
    mode: ImportMode,
  ): Promise<ImportedRecording> {
    const target = await beginImport(sessionId);
    const { staging, mediaDirectory, projectDirectory } = target;

    const imported: HostSegment[] = [];
    for (const segment of segments) {
      const source = path.join(staging, segment.fileName);
      const target = path.join(mediaDirectory, segment.fileName);
      const stagedBytes = await fileSize(source);

      if (stagedBytes !== undefined) {
        const intact =
          stagedBytes === segment.bytes &&
          (mode === 'finished' || (await sha256File(source)) === segment.sha256);
        if (!intact) {
          if (mode === 'finished') {
            throw new StoreError('storage.segment-corrupt');
          }
          warn('recording.recovery.segment-skipped', {
            stream: segment.stream,
            index: segment.index,
          });
          continue;
        }
        await moveFile(source, target);
        imported.push(segment);
      } else if ((await fileSize(target)) === segment.bytes) {
        imported.push(segment); // moved by an import that was interrupted
      } else if (mode === 'finished') {
        throw new StoreError('storage.segment-missing');
      } else {
        warn('recording.recovery.segment-missing', {
          stream: segment.stream,
          index: segment.index,
        });
      }
    }
    if (!imported.some((segment) => segment.stream === 'video')) {
      throw new StoreError('storage.nothing-to-import');
    }

    await completeImport(sessionId, target, { kind: 'segments', segments: imported });
    const durationUs = Math.max(0, ...imported.map((s) => s.startUs + s.durationUs));
    return { projectPath: projectDirectory, durationUs };
  }

  return {
    importMergedSession(sessionId, merged) {
      return guard(() => {
        if (merged.sessionId !== sessionId) {
          throw new StoreError('storage.invalid-session');
        }
        return importMerged(sessionId, merged);
      });
    },

    importSession(sessionId, summary) {
      return guard(() => {
        if (summary.sessionId !== sessionId) {
          throw new StoreError('storage.invalid-session');
        }
        return importSegments(sessionId, summary.segments, 'finished');
      });
    },

    listInterrupted(activeSessionId) {
      return guard(async () => {
        let entries;
        try {
          entries = await readdir(options.stagingRoot, { withFileTypes: true });
        } catch (error) {
          if (errnoOf(error) === 'ENOENT') {
            return [];
          }
          throw error;
        }

        const sessions: InterruptedRecording[] = [];
        for (const entry of entries) {
          if (!entry.isDirectory() || !isOpaqueId(entry.name) || entry.name === activeSessionId) {
            continue;
          }
          const directory = path.join(options.stagingRoot, entry.name);
          let journal: ParsedJournal;
          try {
            journal = await readSessionJournal(directory);
          } catch {
            continue; // not a session directory
          }

          let durationUs = 0;
          let segmentCount = 0;
          for (const segment of journal.segments) {
            if ((await fileSize(path.join(directory, segment.fileName))) === segment.bytes) {
              segmentCount += 1;
              if (segment.stream === 'video') {
                durationUs = Math.max(durationUs, segment.startUs + segment.durationUs);
              }
            }
          }
          const journalStat = await stat(path.join(directory, JOURNAL_FILE_NAME));
          sessions.push({
            sessionId: entry.name,
            startedAt: journalStat.birthtimeMs > 0 ? journalStat.birthtime.toISOString() : null,
            durationUs,
            segmentCount,
            finalized: journal.finalized,
          });
        }
        return sessions.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
      });
    },

    recoverSession(sessionId) {
      return guard(async () => {
        const journal = await readSessionJournal(stagingDirectory(sessionId));
        const imported = await importSegments(sessionId, journal.segments, 'recovery');
        return { sessionId, ...imported };
      });
    },

    discardSession(sessionId) {
      return guard(async () => {
        const staging = stagingDirectory(sessionId);
        await readSessionJournal(staging); // only ever delete a real session directory
        await removeStagedSession(staging);
      });
    },
  };
}
