# Coding standards

## TypeScript and module rules

- `strict` TypeScript is mandatory; `any` is prohibited unless a documented, reviewed boundary exception exists.
- Parse external input as `unknown` and validate it with a schema before use.
- Prefer discriminated unions, opaque IDs, immutable `readonly` values, and explicit result/error types.
- No circular workspace dependency, cross-package deep import, mutable global state, magic path, or direct process invocation from a component.
- React components render and coordinate UI. Business rules live in domain/application modules; side effects live in adapters/hooks with explicit ownership.
- No direct FFmpeg, filesystem, Electron, or native import from `packages/domain`, `packages/application`, or renderer components.

## Naming and files

| Item                           | Convention                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------- |
| Files/folders                  | `kebab-case`; one meaningful concept per file                                    |
| React components/types/classes | `PascalCase`                                                                     |
| Functions/variables            | `camelCase`; verbs for actions                                                   |
| Constants                      | `UPPER_SNAKE_CASE` only for genuine fixed constants; otherwise `camelCase`       |
| Boolean names                  | `is`, `has`, `can`, or `should` prefix                                           |
| IDs                            | Named opaque types such as `ProjectId`, never bare string aliases in public APIs |
| Exports                        | Named exports by default; package public API only from `src/index.ts`            |

## Size and clarity

- A function should do one cohesive thing. Split a function that needs unrelated comments to explain phases.
- A file approaching 300 lines requires a review of whether it owns too many concepts; generated code is exempt.
- Avoid “manager”, “helper”, “util”, and “common” catch-alls. Name the capability or rule.
- Comments explain _why_, invariants, platform behavior, or non-obvious trade-offs—not what obvious code says.
- Public contracts and migrations require TSDoc/Markdown explaining compatibility and ownership.

## Imports and formatting

Use imports in this order: Node built-ins, external packages, workspace packages, then relative modules; separate groups with a blank line. ESLint and Prettier define the executable style. Do not hand-format generated files.

## Git and change management

Use Conventional Commit-style subjects: `feat:`, `fix:`, `docs:`, `test:`, `build:`, `ci:`, `refactor:`, or `chore:`. Keep commits focused. A change crossing a module boundary must identify its contract, migration, error, test, and observability impact in the pull request.

## Error and logging policy

Throw only inside a local implementation when a library requires it; translate to `AppError` at the nearest module boundary. `AppError` has category (`capture`, `audio`, `encoding`, `rendering`, `storage`, `project`, `export`, `native`, `ipc`), stable code, retryability, user-safe message key, correlation ID, and redacted cause metadata. Never use a generic `throw new Error("something failed")` as a boundary contract.

Structured logs use `DEBUG`, `INFO`, `WARN`, `ERROR`, and `FATAL`, with event name, correlation ID, module, duration, and safe context. Screen contents, raw audio, credentials, and unredacted user paths are forbidden fields.
