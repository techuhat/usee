import { z } from 'zod';

import { createAppError, type AppError } from './errors';
import type { CorrelationId } from './ids';

/**
 * Electron main ↔ native recorder host protocol, version 1.3
 * (docs/recorder-host-protocol.md). Frames are a 4-byte little-endian length
 * followed by UTF-8 JSON. These schemas are the canonical definition; the C++
 * host is checked against them by the host integration tests.
 */
export const RECORDER_PROTOCOL_VERSION = Object.freeze({ major: 1, minor: 3 });
export const RECORDER_MAX_FRAME_BYTES = 64 * 1024;

const opaqueId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const count = z.number().int().nonnegative();
const microseconds = z.number().int().nonnegative();

export const hostErrorSchema = z
  .object({
    category: z.enum(['capture', 'audio', 'encoding', 'storage', 'native']),
    code: z
      .string()
      .max(96)
      .regex(/^[a-z]+(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/),
    retryable: z.boolean(),
    detail: z.string().max(256).optional(),
  })
  .readonly();
export type HostError = z.output<typeof hostErrorSchema>;

export const hostDisplaySchema = z
  .object({
    id: opaqueId,
    name: z.string().min(1).max(128),
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    isPrimary: z.boolean(),
    refreshRateHz: count,
  })
  .readonly();
export type HostDisplay = z.output<typeof hostDisplaySchema>;

export const hostAudioInputSchema = z
  .object({ id: opaqueId, name: z.string().min(1).max(256), isDefault: z.boolean() })
  .readonly();
export type HostAudioInput = z.output<typeof hostAudioInputSchema>;

/**
 * Since 1.3: a window the user may choose to record (ADR-009). The title is
 * for the picker only: the journal, the manifest and the logs name a window
 * by its ID.
 */
export const hostWindowSchema = z
  .object({
    id: opaqueId,
    title: z.string().min(1).max(128),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .readonly();
export type HostWindow = z.output<typeof hostWindowSchema>;

/** Since 1.3: a rectangle of a display, in its pixels, recorded instead of all of it. */
export const hostRegionSchema = z
  .object({
    x: z.number().int().min(0).max(16_384),
    y: z.number().int().min(0).max(16_384),
    width: z.number().int().min(64).max(16_384),
    height: z.number().int().min(64).max(16_384),
  })
  .readonly();
export type HostRegion = z.output<typeof hostRegionSchema>;

/** Segment file names the host writes; nothing else in a session directory is media. */
export const SEGMENT_FILE_NAME_PATTERN = /^(?:video-\d{5}\.mp4|audio-\d{5}\.m4a)$/;

const hostSegmentShape = {
  stream: z.enum(['video', 'audio']),
  index: count,
  fileName: z.string().regex(SEGMENT_FILE_NAME_PATTERN),
  startUs: microseconds,
  durationUs: microseconds,
  bytes: count,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  frames: count,
};

export const hostSegmentSchema = z.object(hostSegmentShape).readonly();
export type HostSegment = z.output<typeof hostSegmentSchema>;

/** Since 1.2: the pointer stream a session with `trackPointer` writes beside its segments. */
export const POINTER_FILE_NAME = 'pointer.ndjson';

/** What `mergeSession` writes into the session directory: the recording and its waveform. */
export const MERGED_RECORDING_FILE_NAME = 'recording.mp4';
export const WAVEFORM_FILE_NAME = 'waveform.json';
/** Every file a merge can leave behind, including the partial files of an interrupted one. */
export const MERGE_OUTPUT_FILE_NAMES: readonly string[] = Object.freeze([
  MERGED_RECORDING_FILE_NAME,
  'recording.partial.mp4',
  WAVEFORM_FILE_NAME,
  'waveform.partial.json',
]);

export const hostMergedRecordingSchema = z
  .object({
    sessionId: opaqueId,
    fileName: z.literal(MERGED_RECORDING_FILE_NAME),
    /** Video stream duration on the session clock. */
    durationUs: microseconds,
    bytes: count,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    videoFrames: count,
    hasAudio: z.boolean(),
    segmentsMerged: count,
    segmentsSkipped: count,
    waveform: z
      .object({
        fileName: z.literal(WAVEFORM_FILE_NAME),
        peaksPerSecond: z.number().int().positive(),
        peakCount: count,
      })
      .readonly()
      .nullable(),
  })
  .readonly();
export type HostMergedRecording = z.output<typeof hostMergedRecordingSchema>;

export const hostSessionSummarySchema = z
  .object({
    sessionId: opaqueId,
    durationUs: microseconds,
    framesCaptured: count,
    framesEncoded: count,
    framesDropped: count,
    audioDiscontinuities: count,
    audioFailed: z.boolean(),
    segments: z.array(hostSegmentSchema).max(100_000).readonly(),
    failure: hostErrorSchema.nullable(),
  })
  .readonly();
export type HostSessionSummary = z.output<typeof hostSessionSummarySchema>;

/** What every session is asked for, whatever it records. */
const sessionParamsShape = {
  sessionId: opaqueId,
  frameRateNumerator: z.number().int().positive(),
  frameRateDenominator: z.number().int().positive(),
  includeCursor: z.boolean(),
  /** Since 1.2: record pointer position, clicks and cursor shape (never keystrokes). */
  trackPointer: z.boolean(),
  segmentDurationMs: z.number().int().min(2_000).max(60_000),
  audioInputId: opaqueId.nullable(),
};

/** Every request the host accepts, with its params and result schemas. */
export const recorderMethods = Object.freeze({
  hello: {
    params: z.object({
      protocolMajor: count,
      protocolMinor: count,
      token: z.string().regex(/^[0-9a-f]{64}$/),
    }),
    result: z
      .object({
        protocolMajor: count,
        protocolMinor: count,
        hostVersion: z.string().min(1).max(32),
        capabilities: z
          .object({
            displayCapture: z.boolean(),
            microphone: z.boolean(),
            syntheticSource: z.boolean(),
          })
          .readonly(),
      })
      .readonly(),
  },
  listDisplays: {
    params: z.object({}).strict(),
    result: z.object({ displays: z.array(hostDisplaySchema).max(32).readonly() }).readonly(),
  },
  /** Since 1.3: the windows a user may choose, front first. */
  listWindows: {
    params: z.object({}).strict(),
    result: z.object({ windows: z.array(hostWindowSchema).max(64).readonly() }).readonly(),
  },
  listAudioInputs: {
    params: z.object({}).strict(),
    result: z.object({ inputs: z.array(hostAudioInputSchema).max(64).readonly() }).readonly(),
  },
  startSession: {
    params: z.union([
      z.object({
        ...sessionParamsShape,
        sourceKind: z.literal('display').optional(),
        displayId: opaqueId,
      }),
      /** Since 1.3: one window, by its ID from `listWindows` (ADR-009). */
      z.object({ ...sessionParamsShape, sourceKind: z.literal('window'), windowId: opaqueId }),
      /** Since 1.3: a region of a display, which must lie inside it (ADR-009). */
      z.object({
        ...sessionParamsShape,
        sourceKind: z.literal('region'),
        displayId: opaqueId,
        region: hostRegionSchema,
      }),
    ]),
    result: z
      .object({
        sessionId: opaqueId,
        video: z
          .object({
            width: z.number().int().positive(),
            height: z.number().int().positive(),
            encoderName: z.string().min(1).max(256),
            hardwareEncoder: z.boolean(),
          })
          .readonly(),
        audio: z
          .object({
            sampleRateHz: z.number().int().positive(),
            channels: z.number().int().positive(),
          })
          .readonly()
          .nullable(),
      })
      .readonly(),
  },
  stopSession: {
    params: z.object({ sessionId: opaqueId }),
    result: hostSessionSummarySchema,
  },
  /** Since 1.1: joins a finished session's journaled segments into one MP4. */
  mergeSession: {
    params: z.object({ sessionId: opaqueId, verifyHashes: z.boolean() }),
    result: hostMergedRecordingSchema,
  },
  shutdown: {
    params: z.object({}).strict(),
    result: z.object({}).readonly(),
  },
});

export type RecorderMethod = keyof typeof recorderMethods;
export type RecorderParams<Method extends RecorderMethod> = z.input<
  (typeof recorderMethods)[Method]['params']
>;
export type RecorderResult<Method extends RecorderMethod> = z.output<
  (typeof recorderMethods)[Method]['result']
>;

export const HOST_SESSION_STATES = ['recording', 'finalizing', 'completed', 'failed'] as const;
export type HostSessionState = (typeof HOST_SESSION_STATES)[number];

/** Every event the host emits, with its data schema. */
export const recorderEvents = Object.freeze({
  'session.state': z
    .object({
      sessionId: opaqueId,
      state: z.enum(HOST_SESSION_STATES),
      error: hostErrorSchema.nullable(),
    })
    .readonly(),
  'session.segment': hostSegmentSchema.and(z.object({ sessionId: opaqueId })),
  'session.metrics': z
    .object({
      sessionId: opaqueId,
      elapsedUs: microseconds,
      framesCaptured: count,
      framesEncoded: count,
      framesDropped: count,
      audioFrames: count,
      audioDiscontinuities: count,
    })
    .readonly(),
  'session.stream-failed': z
    .object({ sessionId: opaqueId, stream: z.enum(['video', 'audio']), error: hostErrorSchema })
    .readonly(),
});

export type RecorderEventName = keyof typeof recorderEvents;
export type RecorderEventData<Name extends RecorderEventName> = z.output<
  (typeof recorderEvents)[Name]
>;

/**
 * Envelope of every host → client message, before its body is validated. A
 * plain union: the two response variants share `kind: "response"`, which a
 * discriminated union does not allow.
 */
export const hostMessageSchema = z.union([
  z.object({
    kind: z.literal('response'),
    id: opaqueId,
    ok: z.literal(true),
    result: z.record(z.string(), z.unknown()),
  }),
  z.object({
    kind: z.literal('response'),
    id: opaqueId,
    ok: z.literal(false),
    error: hostErrorSchema,
  }),
  z.object({
    kind: z.literal('event'),
    name: z.string().max(64),
    data: z.record(z.string(), z.unknown()),
  }),
]);
export type HostMessage = z.output<typeof hostMessageSchema>;

/**
 * Host errors use the same `<category>.<reason>` codes as AppError, so the
 * mapping only adds the UI message key and a correlation ID. The host's
 * `detail` (an HRESULT, never a path) becomes redacted diagnostic context.
 */
export function hostErrorToAppError(error: HostError, correlationId: CorrelationId): AppError {
  return createAppError({
    category: error.category,
    code: error.code,
    retryable: error.retryable,
    userMessageKey: `errors.${error.code}`,
    correlationId,
    ...(error.detail === undefined ? {} : { diagnosticContext: { detail: error.detail } }),
  });
}

/**
 * One line of `journal.ndjson`, which the host flushes per record. Recovery
 * trusts only `segment-closed` records whose files still match.
 */
export const journalRecordSchema = z.discriminatedUnion('record', [
  z.object({
    record: z.literal('session-started'),
    sessionId: opaqueId,
    /** Since 1.3; absent from older journals, which all recorded a display. */
    sourceKind: z.enum(['display', 'window', 'region']).optional(),
    /** The recorded display, or the display the region is of; absent for a window. */
    displayId: opaqueId.optional(),
    /** Since 1.3: the recorded window's ID, never its title. */
    windowId: opaqueId.optional(),
    /** Since 1.3: the recorded region of the display. */
    region: hostRegionSchema.optional(),
    protocolMajor: count,
    segmentDurationMs: count,
    video: z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      frameRateNumerator: z.number().int().positive(),
      frameRateDenominator: z.number().int().positive(),
      encoderName: z.string().max(256),
      hardwareEncoder: z.boolean(),
    }),
    audio: z
      .object({ sampleRateHz: z.number().int().positive(), channels: z.number().int().positive() })
      .nullable(),
    /** Since 1.2; absent from older journals. */
    pointer: z
      .object({ fileName: z.literal(POINTER_FILE_NAME) })
      .nullable()
      .optional(),
  }),
  z.object({ record: z.literal('segment-closed'), ...hostSegmentShape }),
  z.object({
    record: z.literal('stream-failed'),
    stream: z.enum(['video', 'audio']),
    code: z.string(),
  }),
  z.object({ record: z.literal('session-failed'), code: z.string() }),
  z.object({
    record: z.literal('session-finalized'),
    durationUs: microseconds,
    framesEncoded: count,
    framesDropped: count,
    segments: count,
    /**
     * Since 1.3: how much older than its frame time a picture is, the median
     * over the session's new pictures, negative when they are shown after
     * their frame time; absent when none was encoded or it was implausible.
     */
    captureLatencyUs: z.number().int().min(-250_000).max(250_000).optional(),
  }),
]);
export type JournalRecord = z.output<typeof journalRecordSchema>;
