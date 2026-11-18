# Error handling

## Error shape

Every error that crosses a module, process, or IPC boundary is an `AppError`:

```ts
interface AppError {
  readonly category:
    | 'capture'
    | 'audio'
    | 'encoding'
    | 'rendering'
    | 'storage'
    | 'project'
    | 'export'
    | 'native'
    | 'ipc';
  readonly code: string;
  readonly retryable: boolean;
  readonly userMessageKey: string;
  readonly correlationId: string;
  readonly diagnosticContext?: Readonly<Record<string, string | number | boolean>>;
}
```

`code` is stable and machine-actionable and always `<category>.<kebab-case-reason>` (for example `ipc.untrusted-sender`); `userMessageKey` maps to safe copy (`errors.<code>`); `diagnosticContext` is redacted and bounded (64-character keys, 512-character strings). `packages/contracts/src/errors.ts` validates all three. Native/library exception text is logged locally with the correlation ID and translated before it reaches UI.

## Rules

- Return `Result<T, AppError>` from application ports and asynchronous command boundaries.
- Use local exceptions only for exceptional library internals; translate them immediately at the adapter boundary.
- Preserve cause chain/correlation locally without leaking raw OS paths, FFmpeg arguments, device names, tokens, or screen data to UI.
- Mark retries only when idempotence and resource state make them safe. Capture start/stop and publish have explicit idempotency keys.
- User cancellation is a first-class `Canceled` outcome, not an error toast.
- The UI offers recovery actions based on error code (retry device, choose another source, free disk space, open recovery, copy support ID) rather than opaque generic alerts.

## Categories

| Category    | Examples                                                                                                                         | Owner                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `capture`   | access denied, source closed, GPU device removed                                                                                 | Capture adapter/coordinator    |
| `audio`     | endpoint missing, unsupported format, clock drift failure                                                                        | Audio adapter                  |
| `encoding`  | unavailable hardware encoder, segment write failure                                                                              | Native encoder adapter         |
| `rendering` | invalid render plan, compositor failure                                                                                          | Render backend                 |
| `storage`   | out of disk, atomic write failure, unsafe path, invalid export-queue snapshot                                                    | Storage adapter                |
| `project`   | invalid manifest, migration not supported                                                                                        | Project manager/format package |
| `export`    | unsupported preset, hash/queue/probe failure, invalid artifact, destination conflict, publish failure, interrupted persisted job | Export service                 |
| `native`    | recorder-host handshake/crash/protocol mismatch                                                                                  | Native-host client             |
| `ipc`       | schema failure, unauthorized channel, version mismatch                                                                           | Preload/main protocol layer    |

Errors are tested for mapping, safety, retryability, and recovery behavior—not merely that an exception is thrown.
