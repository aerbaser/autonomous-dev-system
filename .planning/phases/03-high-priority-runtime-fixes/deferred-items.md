# Phase 03 — Deferred Items

Out-of-scope discoveries logged during plan execution. Do NOT fix in this phase.

## Pre-existing flaky tests observed during HIGH-04 (Plan 03-04) execution

| Test file | Failing test(s) | Symptom | Discovered |
|-----------|-----------------|---------|------------|
| `tests/events/interrupter.test.ts` | `signal aborts in-flight consumeQuery within 100ms` | Timing-based (100ms budget) — fails intermittently under load | 2026-04-22 |
| `tests/self-improve/optimizer.test.ts` | `accepts mutations that improve the score`, `rejects mutations that do not improve the score`, `runs multiple iterations accepting and rejecting` | Intermittent; passes when run in isolation, fails in full suite | 2026-04-22 |
| `tests/self-improve/blueprint-verifier.test.ts` | Whole file: `Cannot find module '../../src/self-improve/blueprint-verifier.js'` | Test imports a module that does not exist in `src/`; pre-existing 80→79 file-count failure noted in baseline (before Plan 03-04) | 2026-04-22 |

**Why deferred:** None of these tests touch `src/phases/specification.ts` or
`tests/phases/specification.test.ts`. Confirmed pre-existing (before Plan 03-04
edits) — see the git-stash check during Plan 03-04 verification: even with the
working tree reverted, `interrupter.test.ts` still showed 1 failure under the
same conditions.

**Suggested follow-up:** Open a dedicated plan to:
1. Stabilize the timing-based interrupter test (raise the abort budget or use
   `vi.useFakeTimers()`).
2. Either delete `tests/self-improve/blueprint-verifier.test.ts` or restore the
   missing `src/self-improve/blueprint-verifier.ts` module.
3. Investigate optimizer mutation tests for shared-state leakage between cases.
