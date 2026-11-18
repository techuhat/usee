# ADR-006: Use semantic render plans and a controlled FFmpeg adapter

- Status: Accepted
- Date: 2026-09-18

## Context

Preview/export need consistent effect semantics, hardware selection, cancellation, and safe FFmpeg execution. Allowing UI strings to become FFmpeg commands is unsafe and untestable.

## Decision

Compile immutable project snapshots into versioned `RenderPlan` objects. Preview and export backends consume the same semantics. The FFmpeg adapter builds the sole approved argument vector from a plan and preset, using a pinned application-owned binary.

## Consequences

The renderer cannot execute arbitrary commands. Render plans can be hashed, snapshot-tested, and versioned. FFmpeg configuration/license/provenance becomes a release artifact. Hardware/export behavior stays behind a backend interface rather than leaking into timeline UI.
