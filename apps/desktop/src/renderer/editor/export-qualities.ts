import type { ExportDefaults } from '@usee/contracts';

export type ExportPresetId = ExportDefaults['presetId'];

/** The approved export presets, as the app names them, smallest first. */
export const EXPORT_QUALITIES: readonly { readonly id: ExportPresetId; readonly label: string }[] =
  [
    { id: 'mp4-h264-1080p30', label: '1080p · 30 fps' },
    { id: 'mp4-h264-1080p60', label: '1080p · 60 fps' },
    { id: 'mp4-h264-1440p30', label: '1440p · 30 fps' },
    { id: 'mp4-h264-4k30', label: '4K · 30 fps' },
  ];
