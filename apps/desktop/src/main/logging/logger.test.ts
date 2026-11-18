import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFileLogger, redactUserPaths } from './logger';

let directory = '';

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'logger-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('file logger', () => {
  it('writes one structured record per line', async () => {
    const logger = createFileLogger({ directory, appVersion: '0.1.0' });
    logger.log('INFO', 'recording.session.started', 'desktop.main', { frameRate: 60 });

    const [line] = (await readFile(path.join(directory, 'main.ndjson'), 'utf8')).trim().split('\n');
    expect(JSON.parse(line ?? '')).toMatchObject({
      level: 'INFO',
      event: 'recording.session.started',
      module: 'desktop.main',
      appVersion: '0.1.0',
      safeContext: { frameRate: 60 },
    });
  });

  it('rotates by size and keeps a bounded number of files', async () => {
    const logger = createFileLogger({ directory, appVersion: '0.1.0', maxBytes: 200, maxFiles: 3 });
    for (let index = 0; index < 50; index += 1) {
      logger.log('INFO', 'tick', 'test', { index });
    }
    const files = (await readdir(directory)).sort();
    expect(files).toEqual(['main.1.ndjson', 'main.2.ndjson', 'main.ndjson']);
  });
});

describe('redactUserPaths', () => {
  it('replaces the profile directory in both slash styles', () => {
    const profile = 'C:\\Users\\Asha';
    expect(redactUserPaths('C:\\Users\\Asha\\Videos\\x.mp4', profile)).toBe(
      '%USERPROFILE%\\Videos\\x.mp4',
    );
    expect(redactUserPaths('C:/Users/Asha/Videos', profile)).toBe('%USERPROFILE%/Videos');
    expect(redactUserPaths('no path here', profile)).toBe('no path here');
  });
});
