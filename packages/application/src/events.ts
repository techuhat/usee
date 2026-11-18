import type { CorrelationId } from '@usee/contracts';

export interface ApplicationEvent {
  readonly type:
    'recording.state-changed' | 'project.saved' | 'render.progress' | 'render.completed';
  /** ISO-8601 wall-clock time; metadata only, never used for media timing. */
  readonly occurredAt: string;
  readonly correlationId?: CorrelationId;
}
