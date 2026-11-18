import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

import { createRecordingStore } from '@usee/adapter-project-fs';
import { createRecorderHostSupervisor } from '@usee/adapter-recorder-host';
import { RecordingService } from '@usee/application';
import { asCorrelationId, asProjectId, asRecordingSessionId } from '@usee/contracts';

import type { Logger, LogLevel } from './logging/logger';
import type { RecordingEnvironment } from './recording-environment';
import type { ProjectLooks } from './settings';

const LEVELS = new Set<LogLevel>(['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']);

/** Re-logs one host NDJSON record, keeping only primitive safe context. */
function forwardHostLog(logger: Logger, record: unknown): void {
  if (typeof record !== 'object' || record === null) {
    return;
  }
  const { level, event, safeContext } = record as Record<string, unknown>;
  const context: Record<string, string | number | boolean> = {};
  if (typeof safeContext === 'object' && safeContext !== null) {
    for (const [key, value] of Object.entries(safeContext)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        context[key] = value;
      }
    }
  }
  logger.log(
    LEVELS.has(level as LogLevel) ? (level as LogLevel) : 'INFO',
    typeof event === 'string' ? event : 'host.unknown',
    'recorder-host',
    context,
  );
}

export interface Recording {
  readonly service: RecordingService;
  dispose(): Promise<void>;
}

/** Wires the recording service to the native host and the project filesystem. */
export async function composeRecording(
  environment: RecordingEnvironment,
  logger: Logger,
  /** The looks each new project starts with, read as it is imported. */
  projectLooks: () => ProjectLooks,
): Promise<Recording> {
  await mkdir(environment.stagingRoot, { recursive: true });
  const createCorrelationId = () => asCorrelationId(randomUUID());

  const host = createRecorderHostSupervisor({
    executablePath: environment.hostExecutablePath,
    stagingRoot: environment.stagingRoot,
    enableSyntheticSource: environment.enableSyntheticSource,
    createCorrelationId,
    onLog: (record) => forwardHostLog(logger, record),
  });
  const store = createRecordingStore({
    stagingRoot: environment.stagingRoot,
    projectsRoot: environment.projectsRoot,
    now: () => new Date(),
    createProjectId: () => asProjectId(randomUUID()),
    createCorrelationId,
    onWarning: (event, context) => logger.log('WARN', event, 'desktop.recording-store', context),
    projectLooks,
  });
  const service = new RecordingService({
    host,
    store,
    createSessionId: () => asRecordingSessionId(randomUUID()),
    createCorrelationId,
    now: () => new Date(),
  });

  service.subscribe((state) => {
    logger.log(
      state.phase === 'failed' ? 'ERROR' : 'INFO',
      `recording.state.${state.phase}`,
      'desktop.main',
      state.phase === 'failed'
        ? { code: state.error.code, correlationId: state.error.correlationId }
        : {},
    );
  });

  return { service, dispose: () => host.dispose() };
}
