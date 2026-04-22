# Phase 03 — Deferred Items

Out-of-scope discoveries logged during plan execution. Do NOT fix in this phase.

## Pre-existing flaky tests observed during HIGH-04 (Plan 03-04) execution

| Test file | Failing test(s) | Symptom | Discovered |
|-----------|-----------------|---------|------------|
| `tests/events/interrupter.test.ts` | `signal aborts in-flight consumeQuery within 100ms` | Timing-based (100ms budget) — fails intermittently under load | 2026-04-22 |
| `tests/self-improve/optimizer.test.ts` | `accepts mutations that improve the score`, `rejects mutations that do not improve the score`, `runs multiple iterations accepting and rejecting` | Intermittent; passes when run in isolation, fails in full suite | 2026-04-22 |
| `tests/self-improve/blueprint-verifier.test.ts` | Whole file: `Cannot find module '../../src/self-improve/blueprint-verifier.js'` | Test imports a module that does not exist in `src/`; pre-existing 80→79 file-count failure noted in baseline (before Plan 03-04) | 2026-04-22 |
| `tests/integration/pipeline.test.ts` | `runs ideation → specification → architecture → environment-setup` | Test timed out in 5000ms — flaky under full-suite import contention; passes when other tests are not co-running | 2026-04-22 (also seen during Plan 03-02 verify) |

**Why deferred:** None of these tests touch `src/phases/specification.ts` or
`tests/phases/specification.test.ts` or `src/evaluation/grader.ts`.
Confirmed pre-existing (before Plan 03-04 edits) — see the git-stash check during
Plan 03-04 verification: even with the working tree reverted, `interrupter.test.ts`
still showed 1 failure under the same conditions. Plan 03-02 only added JSDoc
+ inline comments to grader.ts (zero behavior change) and 2 grader regression
tests, which cannot affect optimizer/interrupter/pipeline test files. The
37 grader-dependent tests (`tests/evaluation/grader.test.ts`,
`tests/evaluation/evaluate-loop.test.ts`,
`tests/integration/rubric-feedback.test.ts`,
`tests/integration/auxiliary-profile.test.ts`,
`tests/integration/orchestrator.test.ts`) all pass after the Plan 03-02 changes.

**Suggested follow-up:** Open a dedicated plan to:
1. Stabilize the timing-based interrupter test (raise the abort budget or use
   `vi.useFakeTimers()`).
2. Either delete `tests/self-improve/blueprint-verifier.test.ts` or restore the
   missing `src/self-improve/blueprint-verifier.ts` module.
3. Investigate optimizer mutation tests for shared-state leakage between cases.

## Re-observed during HIGH-01 (Plan 03-01) execution

| Test file | Failing test(s) | Symptom | Discovered |
|-----------|-----------------|---------|------------|
| `tests/integration/orchestrator.test.ts` | `Orchestrator > runs through ideation → specification → architecture` (pre-existing test at line 114, NOT one of the two HIGH-01 tests added at the end of the file) | Intermittent `Test timed out in 5000ms` under full-suite parallel load; passes 10/10 when file is run in isolation. | 2026-04-22 |
| `tests/events/interrupter.test.ts` | `signal aborts in-flight consumeQuery within 100ms` | Same timing flake already recorded above; observed again during Plan 03-01 full-suite run. | 2026-04-22 |
| `tests/integration/pipeline.test.ts` | `runs ideation → specification → architecture → environment-setup` | Same flake already recorded above; reappeared during Plan 03-01 verification. | 2026-04-22 |

**Confirmation of non-causation:** HIGH-01 edits touch only `src/orchestrator.ts`
(split of a `satisfied || failed` branch) and `src/evaluation/evaluate-loop.ts`
(new helper + two call sites) — no timing code, no SDK/IO change. The full
orchestrator test file passes 10/10 in isolation; both new HIGH-01 tests pass
100% of runs. The remaining flakes are the same load-dependent timeouts
documented above.

## Re-observed during HIGH-05 (Plan 03-05) execution

| Test file | Failing test(s) | Symptom | Discovered |
|-----------|-----------------|---------|------------|
| `tests/events/interrupter.test.ts` | `signal aborts in-flight consumeQuery within 100ms` | Same timing flake already recorded above; elapsed=289ms > 100ms budget under full-suite parallel load. Passes 11/11 in isolation. | 2026-04-22 |
| `tests/integration/pipeline.test.ts` | `runs ideation → specification → architecture → environment-setup` | Same flake already recorded above; timed out in 5000ms under full-suite contention. Passes 4/4 in isolation. | 2026-04-22 |

**Resolved by Plan 03-05:** the entry at the top of this file noting
`tests/self-improve/blueprint-verifier.test.ts` as missing its source module
is now fixed — `src/self-improve/blueprint-verifier.ts` was created by this
plan and the test file has been rewritten with 8 passing cases.

**Confirmation of non-causation (HIGH-05):** HIGH-05 edits touch only
`src/self-improve/optimizer-runner.ts` (new verifier gate), the new file
`src/self-improve/blueprint-verifier.ts`, and two test files
(`blueprint-verifier.test.ts` new, `optimizer-runner.test.ts` extended + fixtures
lengthened). No timing code or SDK/IO change. `tests/self-improve/optimizer.test.ts`
and `tests/self-improve/optimizer-runner.test.ts` now both pass 100% (was 3 of 7
failing in optimizer.test.ts before the Rule 1 fixture fix).
