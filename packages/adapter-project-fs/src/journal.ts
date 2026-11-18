import { journalRecordSchema, type HostSegment, type JournalRecord } from '@usee/contracts';

export const JOURNAL_FILE_NAME = 'journal.ndjson';

type SessionStarted = Extract<JournalRecord, { record: 'session-started' }>;

export interface ParsedJournal {
  readonly started: SessionStarted | undefined;
  readonly segments: readonly HostSegment[];
  readonly finalized: boolean;
  /** How much older than its timestamp a picture is, from the finalized record; absent when unknown. */
  readonly captureLatencyUs: number | undefined;
  /** Lines that were not a valid record, such as a final line cut off by a crash. */
  readonly invalidLines: number;
}

export function parseJournal(text: string): ParsedJournal {
  let started: SessionStarted | undefined;
  const segments: HostSegment[] = [];
  let finalized = false;
  let captureLatencyUs: number | undefined;
  let invalidLines = 0;

  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      invalidLines += 1;
      continue;
    }
    const parsed = journalRecordSchema.safeParse(raw);
    if (!parsed.success) {
      invalidLines += 1;
      continue;
    }
    const entry = parsed.data;
    if (entry.record === 'session-started') {
      started ??= entry;
    } else if (entry.record === 'segment-closed') {
      const { record: _record, ...segment } = entry;
      segments.push(segment);
    } else if (entry.record === 'session-finalized') {
      finalized = true;
      captureLatencyUs = entry.captureLatencyUs;
    }
  }
  return { started, segments, finalized, captureLatencyUs, invalidLines };
}
