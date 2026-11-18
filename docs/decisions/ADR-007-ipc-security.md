# ADR-007: Expose a narrow typed capability bridge

- Status: Accepted
- Date: 2026-09-18

## Context

The renderer renders rich content and must not receive filesystem, process, or raw IPC authority.

## Decision

Use an Electron preload bridge with named methods backed by Zod-validated IPC schemas. Enable context isolation and sandboxing; disable Node integration. Main-to-host RPC has an independent versioned/authenticated protocol.

## Consequences

Adding a capability requires an intentional contract, validation, security review, and tests. Convenience APIs such as generic `invoke`, `runCommand`, or `readFile` are forbidden. The initial bridge is intentionally tiny.
