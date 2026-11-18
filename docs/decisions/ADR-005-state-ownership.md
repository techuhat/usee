# ADR-005: Keep canonical state out of React stores

- Status: Accepted
- Date: 2026-09-18

## Context

Recording, jobs, project history, and UI interactions have different authorities, lifetime, and persistence needs. A single renderer-global store would mix them and make recovery/undo/process failures fragile.

## Decision

Main-process services own project/history/settings and job projections. The native host owns live capture/render resources. The renderer owns only ephemeral view state in small scoped stores; it commits semantic commands to application services.

## Consequences

Undo/redo, persistence, recovery, and cross-window synchronization have one source of truth. Renderer UI remains testable and replaceable. More explicit subscription/command wiring is required, which is preferable to hidden global coupling.
