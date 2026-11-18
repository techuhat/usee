import { z } from 'zod';

const versionString = z.string().min(1).max(64);

/** What the shell reports about itself; safe to show in the UI and support reports. */
export const runtimeInfoSchema = z
  .object({
    applicationName: z.string().min(1).max(100),
    applicationVersion: versionString,
    platform: z.string().min(1).max(32),
    architecture: z.string().min(1).max(32),
    versions: z
      .object({ electron: versionString, chrome: versionString, node: versionString })
      .readonly(),
  })
  .readonly();

export type RuntimeInfo = z.output<typeof runtimeInfoSchema>;
