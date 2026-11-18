import { describe, expect, it, vi } from 'vitest';

import {
  asAssetId,
  asClipId,
  asCorrelationId,
  asEffectId,
  asDurationUs,
  asProjectId,
  asRecordingSessionId,
  asSchemaVersion,
  asTimelineId,
  asTimestampUs,
  asTrackId,
  createAppError,
  err,
  ok,
  type Result,
} from '@usee/contracts';
import type { AnalysisRun, Project, TimelineCommand } from '@usee/domain';

import type { ProjectRepositoryPort } from './project-ports';
import { ProjectSession, type ProjectSessionState } from './project-session';

const SECOND = 1_000_000;

const project: Project = {
  id: asProjectId('project-1'),
  schemaVersion: asSchemaVersion(1),
  title: 'Recording',
  createdAtUs: asTimestampUs(0),
  updatedAtUs: asTimestampUs(0),
  assets: [
    {
      id: asAssetId('recording'),
      kind: 'video',
      createdAtUs: asTimestampUs(0),
      durationUs: asDurationUs(10 * SECOND),
      relativePath: 'media/originals/s/recording.mp4',
      dimensions: { width: 1920, height: 1080 },
      frameRate: { numerator: 30, denominator: 1 },
      hasAudio: true,
    },
  ],
  recordingSessions: [],
  analysisRuns: [],
  timeline: {
    id: asTimelineId('timeline'),
    frameRate: { numerator: 30, denominator: 1 },
    tracks: [
      {
        id: asTrackId('video'),
        kind: 'video',
        muted: false,
        clips: [
          {
            id: asClipId('clip-1'),
            assetId: asAssetId('recording'),
            sourceRange: { startUs: asTimestampUs(0), durationUs: asDurationUs(10 * SECOND) },
            timelineStartUs: asTimestampUs(0),
            effects: [],
          },
        ],
      },
    ],
  },
  settings: {
    defaultFrameRate: { numerator: 30, denominator: 1 },
    previewQuality: 'full',
    colorSpace: 'sdr',
    cursor: { visible: true, size: 1.5, smoothing: 0.5, clickEffect: 'ripple' },
    autoZoom: { enabled: true, scale: 2, disabled: [] },
    canvas: {
      aspect: 'source',
      background: { kind: 'solid', color: '#0b1020' },
      padding: 0,
      cornerRadius: 0,
      shadow: { opacity: 0, blur: 0.04, offsetY: 0.01 },
    },
  },
};

const split = (seconds: number): TimelineCommand => ({
  type: 'split',
  clipId: asClipId('clip-1'),
  atUs: asTimestampUs(seconds * SECOND),
});

function clipCount(state: ProjectSessionState | null): number {
  return state?.project.timeline.tracks[0]?.clips.length ?? 0;
}

function setup(historyLimit?: number) {
  const pending: ((result: Result<void>) => void)[] = [];
  const repository = {
    list: vi.fn<ProjectRepositoryPort['list']>(() => Promise.resolve(ok([]))),
    open: vi.fn<ProjectRepositoryPort['open']>(() =>
      Promise.resolve(ok({ project, migratedFrom: null })),
    ),
    // Each save waits until the test settles it, so overlapping saves are visible.
    save: vi.fn<ProjectRepositoryPort['save']>(
      () => new Promise((resolve) => pending.push(resolve)),
    ),
    readWaveform: vi.fn<ProjectRepositoryPort['readWaveform']>(() => Promise.resolve(ok(null))),
    readPointerTrack: vi.fn<ProjectRepositoryPort['readPointerTrack']>(() =>
      Promise.resolve(ok(null)),
    ),
    readPointerStream: vi.fn<ProjectRepositoryPort['readPointerStream']>(() =>
      Promise.resolve(ok(null)),
    ),
    resolveMediaAssets: vi.fn<ProjectRepositoryPort['resolveMediaAssets']>(() =>
      Promise.resolve(ok({})),
    ),
    readPointerTrackById: vi.fn<ProjectRepositoryPort['readPointerTrackById']>(() =>
      Promise.resolve(ok(null)),
    ),
    readPictureAnalysis: vi.fn<ProjectRepositoryPort['readPictureAnalysis']>(() =>
      Promise.resolve(ok(null)),
    ),
    writePictureChanges: vi.fn<ProjectRepositoryPort['writePictureChanges']>(() =>
      Promise.resolve(ok(undefined)),
    ),
    writeThumbnail: vi.fn<ProjectRepositoryPort['writeThumbnail']>(() =>
      Promise.resolve(ok(undefined)),
    ),
  } satisfies ProjectRepositoryPort;
  let clips = 0;
  const session = new ProjectSession({
    repository,
    createClipId: () => asClipId(`clip-new-${(clips += 1)}`),
    createEffectId: () => asEffectId(`effect-new-${(clips += 1)}`),
    createCorrelationId: () => asCorrelationId('corr'),
    now: () => new Date('2026-10-17T12:00:00.000Z'),
    ...(historyLimit === undefined ? {} : { historyLimit }),
  });
  const states: (ProjectSessionState | null)[] = [];
  session.subscribe((state) => states.push(state));
  /** Finishes the oldest save in progress with `result`. */
  const settle = async (result: Result<void> = ok(undefined)) => {
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
    pending.shift()?.(result);
  };
  return { session, repository, states, settle, pending };
}

describe('ProjectSession', () => {
  it('opens a project with an empty history', async () => {
    const { session } = setup();
    const opened = await session.open('C:/Videos/Recording.screenproj');
    expect(opened).toMatchObject({
      ok: true,
      value: { revision: 0, canUndo: false, canRedo: false, saveState: 'saved' },
    });
    expect(session.state?.project).toBe(project);
  });

  it('applies an edit, records it for undo and saves it in the background', async () => {
    const { session, repository, settle } = setup();
    await session.open('C:/p.screenproj');

    const edited = session.edit(split(4));
    expect(edited).toMatchObject({
      ok: true,
      value: { revision: 1, canUndo: true, canRedo: false, saveState: 'saving' },
    });
    expect(clipCount(session.state)).toBe(2);
    expect(session.state?.project.updatedAtUs).toBe(Date.parse('2026-10-17T12:00:00.000Z') * 1000);
    expect(repository.save).toHaveBeenCalledWith('C:/p.screenproj', session.state?.project);

    await settle();
    await vi.waitFor(() => expect(session.state?.saveState).toBe('saved'));
  });

  it('undoes and redoes whole snapshots, and a new edit clears redo', async () => {
    const { session } = setup();
    await session.open('C:/p.screenproj');
    session.edit(split(4));
    const afterSplit = session.state?.project.timeline;

    expect(session.undo()).toMatchObject({ ok: true, value: { canUndo: false, canRedo: true } });
    expect(session.state?.project.timeline).toBe(project.timeline);
    expect(session.redo()).toMatchObject({ ok: true, value: { canUndo: true, canRedo: false } });
    expect(session.state?.project.timeline).toBe(afterSplit);

    session.undo();
    session.edit(split(6));
    expect(session.state).toMatchObject({ canUndo: true, canRedo: false, revision: 5 });
    // Nothing left to redo or undo is a quiet no-op.
    expect(session.redo()).toMatchObject({ ok: true, value: { revision: 5 } });
  });

  it('keeps edits that change nothing out of the history and unsaved', async () => {
    const { session, repository } = setup();
    await session.open('C:/p.screenproj');
    const result = session.edit({
      type: 'trim',
      clipId: asClipId('clip-1'),
      edge: 'end',
      deltaUs: 5 * SECOND, // already at the end of its media
    });
    expect(result).toMatchObject({ ok: true, value: { revision: 0, canUndo: false } });
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('drops the oldest undo steps beyond the history limit', async () => {
    const { session } = setup(2);
    await session.open('C:/p.screenproj');
    session.edit(split(2));
    session.edit({ type: 'delete', clipId: asClipId('clip-1') });
    session.edit({ type: 'delete', clipId: asClipId('clip-new-1') });
    session.undo();
    session.undo();
    expect(session.state?.canUndo).toBe(false);
    expect(clipCount(session.state)).toBe(2); // the split stays: its step was dropped
  });

  it('saves one change at a time and coalesces the ones made meanwhile', async () => {
    const { session, repository, settle } = setup();
    await session.open('C:/p.screenproj');
    session.edit(split(2)); // clip-1 keeps 0-2 s, clip-new-1 the rest
    session.edit({ ...split(4), clipId: asClipId('clip-new-1') });
    session.edit({ ...split(6), clipId: asClipId('clip-new-2') });
    expect(clipCount(session.state)).toBe(4);
    expect(repository.save).toHaveBeenCalledTimes(1);

    await settle();
    await vi.waitFor(() => expect(repository.save).toHaveBeenCalledTimes(2));
    expect(repository.save).toHaveBeenLastCalledWith('C:/p.screenproj', session.state?.project);
    expect(session.state?.saveState).toBe('saving');
    await settle();
    await vi.waitFor(() => expect(session.state?.saveState).toBe('saved'));
    expect(repository.save).toHaveBeenCalledTimes(2);
  });

  it('reports a failed save and saves again on request', async () => {
    const { session, settle } = setup();
    await session.open('C:/p.screenproj');
    session.edit(split(2));
    const failure = createAppError({
      category: 'storage',
      code: 'storage.disk-full',
      retryable: true,
      userMessageKey: 'errors.storage.disk-full',
      correlationId: asCorrelationId('corr'),
    });
    await settle(err(failure));
    await vi.waitFor(() => expect(session.state?.saveState).toBe('failed'));
    expect(session.state?.saveError).toEqual(failure);

    const retried = session.save();
    await settle();
    await expect(retried).resolves.toMatchObject({ ok: true, value: { saveState: 'saved' } });
  });

  it('closes after the pending save finishes', async () => {
    const { session, settle, states } = setup();
    await session.open('C:/p.screenproj');
    session.edit(split(2));
    const closing = session.close();
    await settle();
    await closing;
    expect(session.state).toBeNull();
    expect(states.at(-1)).toBeNull();
    expect(states.at(-2)).toMatchObject({ saveState: 'saved' });
  });

  it('keeps the current project when another fails to open', async () => {
    const { session, repository } = setup();
    await session.open('C:/p.screenproj');
    repository.open.mockResolvedValueOnce(
      err(
        createAppError({
          category: 'project',
          code: 'project.version-newer',
          retryable: false,
          userMessageKey: 'errors.project.version-newer',
          correlationId: asCorrelationId('corr'),
        }),
      ),
    );
    await expect(session.open('C:/newer.screenproj')).resolves.toMatchObject({
      ok: false,
      error: { code: 'project.version-newer' },
    });
    expect(session.state?.projectPath).toBe('C:/p.screenproj');
  });

  it('maps edit failures to project errors and refuses edits with nothing open', async () => {
    const { session } = setup();
    expect(session.edit(split(2))).toMatchObject({
      ok: false,
      error: { category: 'project', code: 'project.not-open' },
    });
    await session.open('C:/p.screenproj');
    expect(session.edit(split(0))).toMatchObject({
      ok: false,
      error: { code: 'project.split-outside-clip' },
    });
    expect(session.edit({ type: 'delete', clipId: asClipId('nope') })).toMatchObject({
      ok: false,
      error: { code: 'project.clip-not-found' },
    });
  });

  it('takes generated analysis without an undo step, and keeps it through undo', async () => {
    const { session, settle } = setup();
    await session.open('C:/p.screenproj');
    session.edit(split(4));
    await settle();
    const run: AnalysisRun = {
      kind: 'camera-track',
      id: 's-camera',
      sessionId: asRecordingSessionId('s'),
      provenance: {
        strategy: 'click-focus',
        strategyVersion: 1,
        producer: 'usee 0.1.0',
        inputSha256: 'a'.repeat(64),
        generatedAt: '2026-10-19T00:00:00.000Z',
      },
      zooms: [],
    };
    session.applyAnalysis('C:/p.screenproj', [run]);
    await settle();
    expect(session.state?.project.analysisRuns).toEqual([run]);
    expect(session.state?.canUndo).toBe(true); // still just the split to undo

    session.undo();
    await settle();
    expect(clipCount(session.state)).toBe(1);
    expect(session.state?.project.analysisRuns).toEqual([run]);
    expect(session.state?.canUndo).toBe(false);

    // Another project's analysis, or a closed one's, is dropped.
    const revision = session.state?.revision;
    session.applyAnalysis('C:/other.screenproj', [{ ...run, id: 'other-camera' }]);
    expect(session.state?.revision).toBe(revision);
  });

  it('saves a change made just as a save finishes', async () => {
    const { session, repository, settle } = setup();
    await session.open('C:/p.screenproj');
    session.edit(split(4));
    await settle();
    // No pause: the finishing save has not cleared up yet.
    expect(session.edit(split(2)).ok).toBe(true);
    await settle();
    await session.flush();
    expect(repository.save).toHaveBeenCalledTimes(2);
    expect(session.state?.saveState).toBe('saved');
  });
});
