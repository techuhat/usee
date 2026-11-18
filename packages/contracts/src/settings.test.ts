import { describe, expect, it } from 'vitest';

import { appSettingsSchema, SETTINGS_VERSION, updateSettingsRequestSchema } from './settings';

const settings = {
  settingsVersion: SETTINGS_VERSION,
  recording: { frameRate: 60, trackPointer: true, includeCursor: false },
  newProjects: {
    autoZoom: true,
    zoomScale: 2,
    turn3d: 0.6,
    canvas: {
      aspect: 'source',
      background: { kind: 'gradient', from: '#1b2550', to: '#6d3bd1', angle: 135 },
      padding: 0.08,
      cornerRadius: 0.03,
      shadow: { opacity: 0.45, blur: 0.04, offsetY: 0.01 },
    },
  },
  export: { presetId: 'mp4-h264-1080p30' },
} as const;

describe('app settings', () => {
  it('accepts a complete, current snapshot', () => {
    expect(appSettingsSchema.parse(settings)).toEqual(settings);
  });

  it('remembers that the welcome tour was seen, and reads files from before it existed', () => {
    const seen = { ...settings, welcome: { seen: true } };
    expect(appSettingsSchema.parse(seen)).toEqual(seen);
    expect(appSettingsSchema.parse(settings).welcome).toBeUndefined();
    expect(appSettingsSchema.safeParse({ ...settings, welcome: { seen: 'yes' } }).success).toBe(
      false,
    );
    expect(updateSettingsRequestSchema.parse({ welcome: { seen: true } })).toEqual({
      welcome: { seen: true },
    });
  });

  it('refuses another version, so a newer file is never misread', () => {
    expect(appSettingsSchema.safeParse({ ...settings, settingsVersion: 2 }).success).toBe(false);
  });

  it('refuses unknown fields, such as a microphone remembered across recordings', () => {
    const recording = { ...settings.recording, audioInputId: 'mic-1' };
    expect(appSettingsSchema.safeParse({ ...settings, recording }).success).toBe(false);
  });

  it('refuses a default canvas that names an image, which belongs to one project', () => {
    const canvas = { ...settings.newProjects.canvas, background: { kind: 'image', assetId: 'a' } };
    const newProjects = { ...settings.newProjects, canvas };
    expect(appSettingsSchema.safeParse({ ...settings, newProjects }).success).toBe(false);
  });

  it('allows a blurred recording backdrop as a new-project default', () => {
    const canvas = {
      ...settings.newProjects.canvas,
      background: { kind: 'blurred-source', blur: 0.04 },
    };
    const newProjects = { ...settings.newProjects, canvas };
    expect(appSettingsSchema.safeParse({ ...settings, newProjects }).success).toBe(true);
  });

  it('refuses values outside their ranges', () => {
    const newProjects = { ...settings.newProjects, turn3d: 1.5 };
    expect(appSettingsSchema.safeParse({ ...settings, newProjects }).success).toBe(false);
    const recording = { ...settings.recording, frameRate: 24 };
    expect(appSettingsSchema.safeParse({ ...settings, recording }).success).toBe(false);
  });

  it('updates whole sections, and nothing that is not a section', () => {
    const update = { export: { presetId: 'mp4-h264-4k30' } };
    expect(updateSettingsRequestSchema.parse(update)).toEqual(update);
    expect(updateSettingsRequestSchema.safeParse({ settingsVersion: 1 }).success).toBe(false);
    // The renderer never names a path: a folder is chosen in main, if ever.
    const withFolder = { export: { presetId: 'mp4-h264-4k30', folder: 'C:\\Users' } };
    expect(updateSettingsRequestSchema.safeParse(withFolder).success).toBe(false);
  });
});
