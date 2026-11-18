import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ProjectMedia } from './project-media';

const root = path.resolve('fixture', 'Recording.screenproj');
const recording = { id: 'session-1-recording', relativePath: 'media/originals/s/recording.mp4' };

describe('ProjectMedia', () => {
  it('serves the open project’s assets under a per-open token', () => {
    const media = new ProjectMedia();
    media.publish(root, [recording]);
    const url = media.urlFor(recording.id);
    expect(url).toMatch(/^app:\/\/media\/[0-9a-f]{32}\/session-1-recording$/);
    expect(media.resolve(url ?? '')).toEqual({
      filePath: path.join(root, 'media', 'originals', 's', 'recording.mp4'),
      contentType: 'video/mp4',
    });

    media.publish(root, [recording]);
    expect(media.resolve(url ?? '')).toBeUndefined(); // the earlier open's URL is dead
    expect(media.resolve(media.urlFor(recording.id) ?? '')).toBeDefined();
  });

  it('resolves nothing else', () => {
    const media = new ProjectMedia();
    media.publish(root, [
      recording,
      { id: 'notes', relativePath: 'media/originals/s/notes.txt' },
      { id: 'escape', relativePath: '../outside.mp4' },
    ]);
    const url = media.urlFor(recording.id) ?? '';
    const token = url.split('/')[3] ?? '';

    expect(media.urlFor('notes')).toBeUndefined();
    expect(media.urlFor('escape')).toBeUndefined();
    for (const candidate of [
      `app://media/${token}/unknown`,
      `app://media/${token}/session-1-recording/extra`,
      `app://media/${'0'.repeat(32)}/session-1-recording`,
      `app://renderer/${token}/session-1-recording`,
      `https://media/${token}/session-1-recording`,
      'not a url',
    ]) {
      expect(media.resolve(candidate)).toBeUndefined();
    }

    media.clear();
    expect(media.resolve(url)).toBeUndefined();
    expect(media.urlFor(recording.id)).toBeUndefined();
  });

  it('keeps managed media available to an export lease after the project closes', () => {
    const media = new ProjectMedia();
    const assetPath = path.join(root, 'media', 'originals', 's', 'recording.mp4');
    const lease = media.leaseAssets({ [recording.id]: assetPath });
    const url = lease.urlFor(recording.id);

    media.clear();
    expect(media.resolve(url ?? '')).toEqual({ filePath: assetPath, contentType: 'video/mp4' });

    lease.release();
    expect(media.resolve(url ?? '')).toBeUndefined();
  });
});
