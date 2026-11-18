# ADR-004: Use a versioned portable project directory with immutable assets

- Status: Accepted
- Date: 2026-09-18

## Context

Projects must evolve over years, survive interrupted recording/export, be portable, and avoid treating caches as precious user data.

## Decision

Use a `.screenproj` directory with a canonical `manifest.json`, managed media, immutable interaction/session metadata, rebuildable derived/cache folders, and recovery journals. Version the manifest and migrate with pure ordered functions.

## Consequences

Atomic staging/import and checkpoints make recovery practical. Relative, validated references make portable moves reliable. Derived data can be invalidated/regenerated. User settings and machine secrets remain outside projects. The trade-off is a directory format rather than a single opaque file, which is a deliberate choice for media scale and recovery.
