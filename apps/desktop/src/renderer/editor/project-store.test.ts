import { describe, expect, it, vi } from 'vitest';

import {
  asAssetId,
  asClipId,
  asCorrelationId,
  asDurationUs,
  asProjectId,
  createAppError,
  err,
  ok,
  type ProjectSnapshot,
} from '@usee/contracts';

import { createProjectStore, decodePointerTrack, type ProjectBridge } from './project-store';

function snapshot(projectId: string, revision: number): ProjectSnapshot {
  return {
    projectId: asProjectId(projectId),
    title: 'Recording',
    revision,
    canUndo: revision > 0,
    canRedo: false,
    saveState: 'saved',
    saveError: null,
    frameRate: { numerator: 30, denominator: 1 },
    durationUs: asDurationUs(1_000_000),
    cursor: { visible: true, size: 1.5, smoothing: 0.5, clickEffect: 'ripple' },
    autoZoom: { enabled: true, scale: 2, disabled: [] },
    canvas: {
      aspect: 'source',
      background: { kind: 'solid', color: '#0b1020' },
      padding: 0,
      cornerRadius: 0,
      shadow: { opacity: 0, blur: 0.04, offsetY: 0.01 },
    },
    hasPointer: false,
    assets: [],
    tracks: [],
  };
}

function base64(column: Float32Array | Float64Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(column.buffer)));
}

function fakeBridge() {
  let push: (project: ProjectSnapshot | null) => void = () => undefined;
  const bridge = {
    listProjects: vi.fn<ProjectBridge['listProjects']>(() =>
      Promise.resolve(
        ok([
          {
            projectPath: 'C:/p.screenproj',
            title: 'Recording',
            modifiedAt: '2026-10-17T12:00:00.000Z',
          },
        ]),
      ),
    ),
    openProject: vi.fn<ProjectBridge['openProject']>(() => Promise.resolve(ok(snapshot('p', 0)))),
    getProject: vi.fn<ProjectBridge['getProject']>(() => Promise.resolve(ok(null))),
    closeProject: vi.fn<ProjectBridge['closeProject']>(() => Promise.resolve(ok(null))),
    editProject: vi.fn<ProjectBridge['editProject']>(() => Promise.resolve(ok(snapshot('p', 1)))),
    undoProjectEdit: vi.fn<ProjectBridge['undoProjectEdit']>(),
    redoProjectEdit: vi.fn<ProjectBridge['redoProjectEdit']>(),
    saveProject: vi.fn<ProjectBridge['saveProject']>(),
    getWaveform: vi.fn<ProjectBridge['getWaveform']>(() =>
      Promise.resolve(ok({ peaksPerSecond: 100, peaks: 'AID/' })),
    ),
    getPointerTrack: vi.fn<ProjectBridge['getPointerTrack']>(() =>
      Promise.resolve(
        ok({
          display: { width: 1920, height: 1080, dpiScale: 1 },
          moveTimes: base64(new Float64Array([0, 8_333])),
          moveXs: base64(new Float32Array([0.25, 0.5])),
          moveYs: base64(new Float32Array([0.75, 1])),
          clicks: [{ timeUs: 8_333, x: 0.5, y: 1, button: 'left' }],
          shapes: [],
          visibility: [],
        }),
      ),
    ),
    onProjectChanged: vi.fn((listener: (project: ProjectSnapshot | null) => void) => {
      push = listener;
      return () => undefined;
    }),
  } satisfies ProjectBridge;
  return { bridge, push: (project: ProjectSnapshot | null) => push(project) };
}

describe('project store', () => {
  it('opens a project and lists recent ones', async () => {
    const { bridge } = fakeBridge();
    const store = createProjectStore(bridge);
    store.getState().initialize();
    await vi.waitFor(() => expect(store.getState().recent).toHaveLength(1));

    await store.getState().open('C:/p.screenproj');
    expect(bridge.openProject).toHaveBeenCalledWith({ projectPath: 'C:/p.screenproj' });
    expect(store.getState()).toMatchObject({ opening: false, project: { revision: 0 } });
  });

  it('keeps the newest snapshot when events and replies cross', async () => {
    const { bridge, push } = fakeBridge();
    const store = createProjectStore(bridge);
    store.getState().initialize();
    await store.getState().open('C:/p.screenproj');

    push(snapshot('p', 3));
    await store.getState().edit({ type: 'delete', clipId: asClipId('c') });
    expect(store.getState().project?.revision).toBe(3); // the reply (revision 1) was older

    push(snapshot('other', 0));
    expect(store.getState().project?.projectId).toBe('other');
    push(null);
    expect(store.getState().project).toBeNull();
  });

  it('shows an edit error and lets it be dismissed', async () => {
    const { bridge } = fakeBridge();
    const failure = createAppError({
      category: 'project',
      code: 'project.split-outside-clip',
      retryable: false,
      userMessageKey: 'errors.project.split-outside-clip',
      correlationId: asCorrelationId('corr'),
    });
    bridge.editProject.mockResolvedValueOnce(err(failure));
    const store = createProjectStore(bridge);
    await store.getState().edit({ type: 'delete', clipId: asClipId('c') });
    expect(store.getState().error).toEqual(failure);
    store.getState().dismissError();
    expect(store.getState().error).toBeUndefined();
  });

  it('decodes each waveform once', async () => {
    const { bridge } = fakeBridge();
    const store = createProjectStore(bridge);
    await Promise.all([
      store.getState().loadWaveform(asAssetId('recording')),
      store.getState().loadWaveform(asAssetId('recording')),
    ]);
    expect(bridge.getWaveform).toHaveBeenCalledOnce();
    const waveform = store.getState().waveforms['recording'];
    expect(waveform?.peaksPerSecond).toBe(100);
    expect([...(waveform?.peaks ?? [])]).toEqual([0, 128, 255]);
  });

  it('decodes each pointer stream once into columns', async () => {
    const { bridge } = fakeBridge();
    const store = createProjectStore(bridge);
    await Promise.all([
      store.getState().loadPointerTrack(asAssetId('pointer')),
      store.getState().loadPointerTrack(asAssetId('pointer')),
    ]);
    expect(bridge.getPointerTrack).toHaveBeenCalledOnce();
    const track = store.getState().pointerTracks['pointer'];
    expect([...(track?.moveTimes ?? [])]).toEqual([0, 8_333]);
    expect([...(track?.moveXs ?? [])]).toEqual([0.25, 0.5]);
    expect([...(track?.moveYs ?? [])]).toEqual([0.75, 1]);
    expect(track?.clicks).toHaveLength(1);
  });

  it('ignores a pointer stream whose columns disagree', () => {
    expect(
      decodePointerTrack({
        display: { width: 1920, height: 1080, dpiScale: 1 },
        moveTimes: base64(new Float64Array([0, 1])),
        moveXs: base64(new Float32Array([0.5])),
        moveYs: base64(new Float32Array([0.5])),
        clicks: [],
        shapes: [],
        visibility: [],
      }),
    ).toBeNull();
  });

  it('clears the project and refreshes the list on close', async () => {
    const { bridge } = fakeBridge();
    const store = createProjectStore(bridge);
    await store.getState().open('C:/p.screenproj');
    await store.getState().close();
    expect(store.getState().project).toBeNull();
    expect(bridge.listProjects).toHaveBeenCalled();
  });
});
