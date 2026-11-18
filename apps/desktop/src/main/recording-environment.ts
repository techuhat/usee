import path from 'node:path';

/** The app's name on disk. */
const FOLDER_NAME = 'usee';

export interface RecordingEnvironmentInput {
  readonly isPackaged: boolean;
  /** `app.getAppPath()`: apps/desktop when unpackaged. */
  readonly appPath: string;
  readonly resourcesPath: string;
  readonly localAppData: string | undefined;
  readonly tempDirectory: string;
  readonly videosDirectory: string;
  readonly logsDirectory: string;
  /** `USEE_TEST_DATA_DIR`: redirects all data for automated tests. */
  readonly testDataDirectory: string | undefined;
  /** `USEE_ENABLE_SYNTHETIC_SOURCE`: offers the synthetic test pattern. */
  readonly syntheticSource: string | undefined;
}

export interface RecordingEnvironment {
  readonly hostExecutablePath: string;
  /** Media is large and machine-local, so staging lives in LocalAppData, not the roaming profile. */
  readonly stagingRoot: string;
  readonly projectsRoot: string;
  readonly logsDirectory: string;
  readonly enableSyntheticSource: boolean;
}

/**
 * Where the recorder host lives and where recordings go. The test overrides
 * apply only to unpackaged builds, so an environment variable can never
 * redirect a shipped app's data or add the synthetic source to it.
 */
export function resolveRecordingEnvironment(
  input: RecordingEnvironmentInput,
): RecordingEnvironment {
  const hostExecutablePath = input.isPackaged
    ? path.join(input.resourcesPath, 'recorder-host', 'recorder-host.exe')
    : path.join(
        input.appPath,
        '..',
        '..',
        'native',
        'recorder-host',
        'build',
        'release',
        'recorder-host.exe',
      );

  const testData =
    !input.isPackaged &&
    input.testDataDirectory !== undefined &&
    path.isAbsolute(input.testDataDirectory)
      ? input.testDataDirectory
      : undefined;
  if (testData !== undefined) {
    return {
      hostExecutablePath,
      stagingRoot: path.join(testData, 'staging'),
      projectsRoot: path.join(testData, 'projects'),
      logsDirectory: path.join(testData, 'logs'),
      enableSyntheticSource: input.syntheticSource === '1',
    };
  }

  const local = input.localAppData ?? input.tempDirectory;
  return {
    hostExecutablePath,
    stagingRoot: path.join(local, FOLDER_NAME, 'staging'),
    projectsRoot: path.join(input.videosDirectory, FOLDER_NAME),
    logsDirectory: input.logsDirectory,
    enableSyntheticSource: !input.isPackaged && input.syntheticSource === '1',
  };
}
