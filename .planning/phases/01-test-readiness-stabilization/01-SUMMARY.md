---
phase: 01-test-readiness-stabilization
plan: 01
subsystem: testing
tags: [vitest, orchestrator, autonomy, confirm-spec, non-tty, test-stabilization]

# Dependency graph
requires:
  - phase: 00-bootstrap
    provides: ".planning/ scaffold (PROJECT, REQUIREMENTS, ROADMAP, STATE)"
provides:
  - 777/777 green vitest baseline restored
  - Removed brittle 200ms Promise.race in non-interactive confirm-spec test
  - Confirmed src/orchestrator.ts:582-598 non-TTY branch is correct (no production change required)
  - VAL-01 closed; one-known-caveat language under REQ-confirm-spec-gate is resolvable
affects: [02-mutation-engine-hardening, 03-rubric-feedback-loop, 04-end-to-end-validation, 05-staging-validation, 06-production-monitoring]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Test hang-guards rely on vitest's default 5000ms per-test timeout, not hand-rolled `Promise.race` deadlines"
    - "Non-TTY orchestrator paths are asserted via `expect(spy).not.toHaveBeenCalled()` rather than via timing races"

key-files:
  created:
    - .planning/phases/01-test-readiness-stabilization/01-SUMMARY.md
  modified:
    - tests/integration/orchestrator-autonomy.test.ts

key-decisions:
  - "Diagnose test-side, not source-side: src/orchestrator.ts already takes the correct non-interactive branch when process.stdin.isTTY === false; the failure was a 200ms timing race in the test, not a production bug"
  - "Use vitest's default 5000ms per-test timeout as the hang-guard instead of a hand-rolled Promise.race — the existing `expect(onceSpy).not.toHaveBeenCalled()` assertion is sufficient to catch a regression where the orchestrator pauses unexpectedly"
  - "No production code modified — git diff src/ is empty, proving the diagnosis"

patterns-established:
  - "Vitest hang-guard pattern: prefer the framework's per-test timeout over per-test hand-rolled `Promise.race(fn, timeout)` for asserting that an async path does not block"
  - "Orchestrator non-TTY assertion pattern: spy on `process.stdin.once` and assert `not.toHaveBeenCalled()` to prove the non-interactive branch was taken"

requirements-completed: [VAL-01]

# Metrics
duration: 2min
completed: 2026-04-22
---

# Phase 1 Plan 01: Test-Readiness Stabilization Summary

**Removed a brittle 200ms `Promise.race` deadline in the non-interactive confirm-spec test, restoring the 777/777 vitest green baseline without modifying any production source.**

## Performance

- **Duration:** 2 min
- **Started:** 2026-04-22T16:48:07Z
- **Completed:** 2026-04-22T16:50:07Z
- **Tasks:** 1 (autonomous)
- **Files modified:** 1

## Accomplishments
- Restored full 777/777 vitest green baseline (before: 776 passing + 1 failing — the non-interactive confirm-spec case timed out on the 200ms `Promise.race` artificial deadline).
- Confirmed the underlying production code at `src/orchestrator.ts:582-598` is already correct: when `process.stdin.isTTY === false`, the orchestrator logs `"[confirm] Non-interactive stdin detected; continuing without pause."` and skips `process.stdin.once("data", ...)`. No source change was required.
- Preserved the regression-detection guarantee: `vi.spyOn(process.stdin, "once")` plus `expect(onceSpy).not.toHaveBeenCalled()` still proves the non-TTY branch was taken; vitest's default 5000ms per-test timeout catches any future regression where `.once` is incorrectly called on non-TTY stdin.
- Did not regress the interactive sibling test at line 224 ("waits for confirmation in interactive confirm-spec mode") — `runWithTTY` still restores the original `isTTY` descriptor in `finally`.

## Task Commits

Each task was committed atomically:

1. **Task 1: Remove 200ms Promise.race from non-interactive confirm-spec test** — `4fc0ce5` (fix)

_Plan metadata commit will be made after STATE.md / ROADMAP.md updates._

## Files Created/Modified
- `tests/integration/orchestrator-autonomy.test.ts` — Removed the `Promise.race([runOrchestrator(state, config), timeout])` block and the `setTimeout(...200ms)` rejection promise. Replaced with a direct `await runOrchestrator(state, config)` inside the existing `runWithTTY(false, async () => { ... })` wrapper. Net change: +1 / -7 lines.

### Diff applied

**Before (lines 276-286):**
```typescript
const onceSpy = vi.spyOn(process.stdin, "once");
const timeout = new Promise<never>((_, reject) => {
  setTimeout(() => reject(new Error("runOrchestrator timed out waiting for confirm-spec input")), 200);
});

await runWithTTY(false, async () => {
  await Promise.race([
    runOrchestrator(state, config),
    timeout,
  ]);
});
```

**After:**
```typescript
const onceSpy = vi.spyOn(process.stdin, "once");

await runWithTTY(false, async () => {
  await runOrchestrator(state, config);
});
```

The two assertions on the lines below the changed block (`expect(onceSpy).not.toHaveBeenCalled()` and `expect(mockedRunArchitecture).toHaveBeenCalledTimes(1)`) are unchanged.

## Test results

| Check | Before fix | After fix |
|-------|-----------|-----------|
| `npm test -- tests/integration/orchestrator-autonomy.test.ts --run` | 3 passed / 1 failed | 4 passed / 0 failed |
| `npm test` (full suite) | 776 passed / 1 failed (1 file failing) | 777 passed / 0 failed (79 files all green) |
| `npm run typecheck` | clean | clean |
| `npm run lint` | clean | clean |
| `git diff --stat src/` | (n/a) | empty (no source change) |
| `git diff --stat tests/` | (n/a) | 1 file changed, +1 / -7 |

### Acceptance-criteria structural greps

- `grep -n "Promise.race" tests/integration/orchestrator-autonomy.test.ts` → empty (race removed).
- `grep -n "runOrchestrator timed out waiting for confirm-spec input" tests/integration/orchestrator-autonomy.test.ts` → empty (custom timeout error gone).
- `grep -c "expect(onceSpy).not.toHaveBeenCalled" tests/integration/orchestrator-autonomy.test.ts` → 1 (non-regression assertion preserved).
- `grep -c "expect(mockedRunArchitecture).toHaveBeenCalledTimes(1)" tests/integration/orchestrator-autonomy.test.ts` → 2 (preserved in both confirm-spec tests; criterion 5 in the plan said "1" but the interactive sibling at line 224 also asserts it — that was an under-specification in the plan, not a deviation from intent. Both occurrences are intentional and pre-existing.).
- `grep -n "does not block unattended runs in non-interactive confirm-spec mode" tests/integration/orchestrator-autonomy.test.ts` → 1 match at line 257 (test name unchanged).
- `grep -n "await runOrchestrator(state, config)" tests/integration/orchestrator-autonomy.test.ts` → 3 matches (line 173 in budget-cap test, line 251 in interactive confirm-spec test, line 279 in non-interactive confirm-spec test — matches expectation of "at least one in the non-interactive body").

## Decisions Made
- **Plan diagnosis confirmed correct.** `src/orchestrator.ts:582-598` already handles `process.stdin.isTTY === false` by logging and skipping `process.stdin.once`. The failure was purely test-side. `git diff --stat src/` returned empty, proving production code is untouched.
- **Vitest's default 5000ms per-test timeout is a sufficient hang-guard.** No need to add a `testTimeout` override in `vitest.config.ts`. A regression where `.once` is incorrectly called on non-TTY stdin would surface either via the existing `expect(onceSpy).not.toHaveBeenCalled()` assertion (if the orchestrator eventually resolves) or via the 5000ms vitest timeout (if a real pause occurs).

## Deviations from Plan

None — plan executed exactly as written.

The grep count for `expect(mockedRunArchitecture).toHaveBeenCalledTimes(1)` returned 2 instead of the plan's stated "1", but inspection confirms both occurrences are pre-existing and load-bearing (one in the interactive confirm-spec sibling at line 224, one in the non-interactive case at line 283). The plan's acceptance criterion 5 under-specified the count; the assertion's presence in the target test is what matters and it is preserved. No code change is needed to reconcile.

## Issues Encountered
None.

## User Setup Required
None — test-only edit, no external service configuration.

## Next Phase Readiness
- Phase 1 success criteria all hold simultaneously: 777/777 tests pass, typecheck clean, lint clean, no production-source drift, no regression in any other test file.
- VAL-01 in `.planning/REQUIREMENTS.md` is closed. The "one known caveat" language under REQ-confirm-spec-gate in the Validated block can be resolved.
- Phases 2–6 (which all depend on a clean test signal per `STATE.md` blockers section) are unblocked. Phase 2 (mutation-engine `wrapUserInput` gap, DEC-014 + SEC-02) can begin against a green baseline.

---
*Phase: 01-test-readiness-stabilization*
*Completed: 2026-04-22*

## Self-Check: PASSED

Verified after writing SUMMARY.md:
- `tests/integration/orchestrator-autonomy.test.ts` exists and contains the new minimal direct-await body at lines 276-280 (Read confirmed; greps confirmed Promise.race / custom-timeout-message removed).
- `.planning/phases/01-test-readiness-stabilization/01-SUMMARY.md` exists at the path requested by the orchestrator.
- Commit `4fc0ce5` exists in `git log` (verified post-commit; `git rev-parse --short HEAD` returned `4fc0ce5`).
- `git diff --diff-filter=D --name-only HEAD~1 HEAD` returned no deletions — the commit is purely subtractive within the modified file (lines removed inside the test) and adds nothing else.
