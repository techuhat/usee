import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  resolveRecordingEnvironment,
  type RecordingEnvironmentInput,
} from './recording-environment';

const base: RecordingEnvironmentInput = {
  isPackaged: false,
  appPath: path.join('C:', 'repo', 'apps', 'desktop'),
  resourcesPath: path.join('C:', 'Program Files', 'usee', 'resources'),
  localAppData: path.join('C:', 'Users', 'u', 'AppData', 'Local'),
  tempDirectory: path.join('C:', 'Temp'),
  videosDirectory: path.join('C:', 'Users', 'u', 'Videos'),
  logsDirectory: path.join('C:', 'Users', 'u', 'AppData', 'Roaming', 'usee', 'logs'),
  testDataDirectory: undefined,
  syntheticSource: undefined,
};

describe('resolveRecordingEnvironment', () => {
  it('uses LocalAppData for staging and Videos for projects', () => {
    const local = path.join('C:', 'Users', 'u', 'AppData', 'Local');
    const videos = path.join('C:', 'Users', 'u', 'Videos');
    expect(resolveRecordingEnvironment(base)).toEqual({
      hostExecutablePath: path.join(
        'C:',
        'repo',
        'native',
        'recorder-host',
        'build',
        'release',
        'recorder-host.exe',
      ),
      stagingRoot: path.join(local, 'usee', 'staging'),
      projectsRoot: path.join(videos, 'usee'),
      logsDirectory: base.logsDirectory,
      enableSyntheticSource: false,
    });
  });

  it('runs the bundled host from resources when packaged', () => {
    expect(resolveRecordingEnvironment({ ...base, isPackaged: true }).hostExecutablePath).toBe(
      path.join(base.resourcesPath, 'recorder-host', 'recorder-host.exe'),
    );
  });

  it('redirects data and allows the synthetic source for unpackaged tests', () => {
    const testData = path.resolve('test-data');
    const environment = resolveRecordingEnvironment({
      ...base,
      testDataDirectory: testData,
      syntheticSource: '1',
    });
    expect(environment).toMatchObject({
      stagingRoot: path.join(testData, 'staging'),
      projectsRoot: path.join(testData, 'projects'),
      enableSyntheticSource: true,
    });
  });

  it('ignores test overrides in a packaged build', () => {
    const environment = resolveRecordingEnvironment({
      ...base,
      isPackaged: true,
      testDataDirectory: path.resolve('test-data'),
      syntheticSource: '1',
    });
    expect(environment.projectsRoot).toBe(path.join('C:', 'Users', 'u', 'Videos', 'usee'));
    expect(environment.enableSyntheticSource).toBe(false);
  });

  it('ignores a relative test data directory', () => {
    expect(
      resolveRecordingEnvironment({ ...base, testDataDirectory: 'relative/dir' }).stagingRoot,
    ).toContain('AppData');
  });
});
