# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

Sections 1–4 are from [andrej-karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills) (MIT).

## Project-Specific Guidelines

- `docs/` is the specification. Build in the order of `docs/development-phases.md`; when code must differ from a doc, update the doc in the same change.
- Before committing, `npm run check` must pass. Shell or bridge changes also need `npm run test:e2e`; native changes need `node scripts/build-native.mjs` (builds and runs the C++ tests).
- Import rules live in `scripts/check-boundaries.mjs`. A new workspace or source directory needs a rule there first.
- Workspace dependencies use `"*"`, never `workspace:*` (npm rejects it). Pin exact versions.
- Automated tests never capture the real screen or microphone. Use the host's synthetic source (`USEE_SYNTHETIC_SOURCE=1`); real-device tests are opt-in.
- Commits use Conventional Commit subjects. Each phase is developed on its own branch and merged to `main` after its exit check passes.

### Environment notes (this machine)

- The office network re-signs HTTPS (FortiGate), so `npm install` fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. Install from another network; never disable `strict-ssl`.
- Shells started by VS Code extensions inherit `ELECTRON_RUN_AS_NODE=1`. Launch Electron through `npm start`, `npm run dev` or the E2E helper, which clear it.
- `NoDefaultCurrentDirectoryInExePath=1` breaks `vcvars64.bat`; `scripts/build-native.mjs` removes it for the native build only.
