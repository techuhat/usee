import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';

import type {
  ExportJobStatusDto,
  ExportQueueViewDto,
  ExportRuntimeStatusDto,
} from '@usee/contracts';

import { messageFor } from '../messages';
import type { SettingsStore } from '../settings/settings-store';
import { EXPORT_QUALITIES, type ExportPresetId } from './export-qualities';

const JOB_LABELS: Readonly<Record<ExportJobStatusDto['job']['state'], string>> = {
  queued: 'Queued',
  preparing: 'Preparing',
  rendering: 'Rendering',
  validating: 'Checking video',
  publishing: 'Saving video',
  succeeded: 'Done',
  canceled: 'Canceled',
  failed: 'Failed',
};

function upsert(jobs: readonly ExportJobStatusDto[], update: ExportJobStatusDto) {
  return [update, ...jobs.filter(({ job }) => job.id !== update.job.id)].sort(
    (first, second) => second.job.createdAtUs - first.job.createdAtUs,
  );
}

/** The export queue and its controls; the quality chosen is remembered in the settings. */
export function ExportPanel({ settings }: { readonly settings: SettingsStore }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ExportQueueViewDto | null>(null);
  const presetId: ExportPresetId = useStore(
    settings,
    (state) => state.settings?.export.presetId ?? 'mp4-h264-1080p30',
  );
  const setPresetId = (id: ExportPresetId) =>
    void settings.getState().update({ export: { presetId: id } });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updates = useRef(new Map<string, ExportJobStatusDto>());

  useEffect(() => {
    const unsubscribe = window.desktop.onExportQueueChanged((update) => {
      updates.current.set(update.job.id, update);
      setView((current) =>
        current === null ? current : { ...current, jobs: upsert(current.jobs, update) },
      );
    });
    void window.desktop.getExportQueue().then((result) => {
      if (!result.ok) {
        setError(messageFor(result.error.userMessageKey));
        return;
      }
      setView({
        ...result.value,
        jobs: [...result.value.jobs, ...updates.current.values()].reduce<ExportJobStatusDto[]>(
          (jobs, update) => upsert(jobs, update),
          [],
        ),
      });
    });
    return unsubscribe;
  }, []);

  const enqueue = async () => {
    setBusy(true);
    setError(null);
    const result = await window.desktop.queueExport({ presetId });
    if (result.ok) {
      if (result.value !== null) {
        const update = result.value;
        updates.current.set(update.job.id, update);
        setView((current) =>
          current === null ? current : { ...current, jobs: upsert(current.jobs, update) },
        );
      }
    } else {
      setError(messageFor(result.error.userMessageKey));
    }
    setBusy(false);
  };

  const cancel = async (renderJobId: ExportJobStatusDto['job']['id']) => {
    const result = await window.desktop.cancelExport({ renderJobId });
    if (!result.ok) {
      setError(messageFor(result.error.userMessageKey));
    }
  };

  const runtime: ExportRuntimeStatusDto | null = view?.runtime ?? null;

  return (
    <div className="export-panel-wrap">
      <button
        type="button"
        className="export-open-button"
        aria-expanded={open}
        aria-controls="export-panel"
        data-testid="export-open"
        onClick={() => setOpen((value) => !value)}
      >
        Export
      </button>
      {open && (
        <section className="export-panel" id="export-panel" role="dialog" aria-label="Export video">
          <header className="export-panel-header">
            <h3>Export video</h3>
            <button
              type="button"
              className="ghost"
              onClick={() => setOpen(false)}
              aria-label="Close export panel"
            >
              Close
            </button>
          </header>
          <label className="export-preset-label" htmlFor="export-preset">
            Quality
          </label>
          <select
            id="export-preset"
            data-testid="export-preset"
            value={presetId}
            onChange={(event) => setPresetId(event.target.value as ExportPresetId)}
          >
            {EXPORT_QUALITIES.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
          {runtime?.available === false && (
            <p className="field-note" role="status">
              {runtime.reason === null
                ? 'The approved video encoder is unavailable.'
                : messageFor(`errors.${runtime.reason}`)}
            </p>
          )}
          <button
            type="button"
            className="export-start-button"
            data-testid="export-start"
            disabled={busy || runtime?.available !== true}
            onClick={() => void enqueue()}
          >
            {busy ? 'Preparing…' : 'Choose file and export'}
          </button>
          {error !== null && (
            <p className="status-error" role="alert">
              {error}
            </p>
          )}
          <div className="export-job-list" aria-label="Export queue">
            {(view?.jobs ?? []).map((entry) => {
              const { job } = entry;
              const active =
                job.state === 'queued' ||
                job.state === 'preparing' ||
                job.state === 'rendering' ||
                job.state === 'validating' ||
                job.state === 'publishing';
              return (
                <article className="export-job" key={job.id}>
                  <div className="export-job-heading">
                    <span>{JOB_LABELS[job.state]}</span>
                    {active && (
                      <button type="button" className="ghost" onClick={() => void cancel(job.id)}>
                        Cancel
                      </button>
                    )}
                  </div>
                  {active && <progress max={1} value={job.progress} aria-label="Export progress" />}
                  {entry.error !== null && (
                    <p className="field-note">{messageFor(entry.error.userMessageKey)}</p>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
