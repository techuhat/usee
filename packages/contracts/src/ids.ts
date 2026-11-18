import { z } from 'zod';

import type { Brand } from './brand';

export type ProjectId = Brand<string, 'ProjectId'>;
export type AssetId = Brand<string, 'AssetId'>;
export type RecordingSessionId = Brand<string, 'RecordingSessionId'>;
export type TimelineId = Brand<string, 'TimelineId'>;
export type TrackId = Brand<string, 'TrackId'>;
export type ClipId = Brand<string, 'ClipId'>;
export type EffectId = Brand<string, 'EffectId'>;
export type JobId = Brand<string, 'JobId'>;
export type CorrelationId = Brand<string, 'CorrelationId'>;

/**
 * Opaque identifiers are 1–128 URL- and path-safe characters. The format is
 * deliberately loose (UUIDs, ULIDs and test fixtures all fit) but it rejects
 * separators, dots and whitespace, so an ID can never smuggle a path segment.
 */
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isOpaqueId(value: string): boolean {
  return OPAQUE_ID_PATTERN.test(value);
}

function opaqueId<Id extends string>(kind: string) {
  return (value: string): Id => {
    if (!isOpaqueId(value)) {
      throw new TypeError(`Invalid ${kind}: expected 1-128 characters of [A-Za-z0-9_-].`);
    }
    return value as Id;
  };
}

export const asProjectId = opaqueId<ProjectId>('ProjectId');
export const asAssetId = opaqueId<AssetId>('AssetId');
export const asRecordingSessionId = opaqueId<RecordingSessionId>('RecordingSessionId');
export const asTimelineId = opaqueId<TimelineId>('TimelineId');
export const asTrackId = opaqueId<TrackId>('TrackId');
export const asClipId = opaqueId<ClipId>('ClipId');
export const asEffectId = opaqueId<EffectId>('EffectId');
export const asJobId = opaqueId<JobId>('JobId');
export const asCorrelationId = opaqueId<CorrelationId>('CorrelationId');

const opaqueIdString = z
  .string()
  .regex(OPAQUE_ID_PATTERN, { error: 'Expected an opaque identifier ([A-Za-z0-9_-], 1-128).' });

/** An opaque identifier with no brand of its own, such as a generated zoom's. */
export const opaqueIdSchema = opaqueIdString;

export const projectIdSchema = opaqueIdString.transform((value) => value as ProjectId);
export const assetIdSchema = opaqueIdString.transform((value) => value as AssetId);
export const recordingSessionIdSchema = opaqueIdString.transform(
  (value) => value as RecordingSessionId,
);
export const timelineIdSchema = opaqueIdString.transform((value) => value as TimelineId);
export const trackIdSchema = opaqueIdString.transform((value) => value as TrackId);
export const clipIdSchema = opaqueIdString.transform((value) => value as ClipId);
export const effectIdSchema = opaqueIdString.transform((value) => value as EffectId);
export const jobIdSchema = opaqueIdString.transform((value) => value as JobId);
export const correlationIdSchema = opaqueIdString.transform((value) => value as CorrelationId);
