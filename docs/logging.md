# Logging and diagnostics

## Structured records

Logs are newline-delimited structured records with these baseline fields:

```text
timestamp, level, event, module, correlationId, processId, appVersion,
projectId? (hashed), durationMs?, safeContext?
```

Levels are `DEBUG`, `INFO`, `WARN`, `ERROR`, and `FATAL`. Log event names are stable (for example `recording.session.started`, `native.host.disconnected`, `export.validation.failed`) and safe context is typed at each adapter.

## Privacy rules

Never log screen pixels, screenshots, raw audio, clipboard content, typed text, window titles, unredacted paths, tokens, update credentials, or complete FFmpeg command lines. Device names and project IDs are hashed/redacted where they are not required for local support diagnosis. Diagnostic exports require explicit user action and show their contents/retention policy.

## Operational behavior

- Renderer, main, recorder host, and FFmpeg adapter emit correlation-compatible records.
- Recording/session/job IDs join lifecycle events across processes without sending raw capture data.
- Logs rotate by size/count and respect a bounded retention policy.
- Process crashes record safe crash metadata and a recovery-journal location, then the main process offers recovery rather than silently retrying live capture.
- Future telemetry is a separate opt-in sink; it is not an alternate implementation of local logging.
