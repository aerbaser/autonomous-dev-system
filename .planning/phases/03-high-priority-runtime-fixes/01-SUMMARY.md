---
phase: 03-high-priority-runtime-fixes
plan: 01
subsystem: orchestrator / evaluation
tags: [HIGH-01, rubric-feedback-loop, ledger-escalation, verification_failed, run-ledger]
requires:
  - RunLedger.startSession + recordFailure + endSession API (src/state/run-ledger.ts)
  - CanonicalFailureReasonCode union containing "verification_failed" (src/types/failure-codes.ts)
  - setActiveLedger/getActiveLedger module-level singleton (src/state/run-ledger.ts)
  - getPhaseRubric() for architecture phase (src/evaluation/phase-rubrics.ts)
provides:
  - end-to-end rubric feedback loop with ledger-escalation on `failed` verdict
  - parity escalation in the standalone evaluateWithRubric() helper
  - regression tests asserting both (a) failed → ledger entry, (b) needs_revision → handler re-invoked with rubricFeedback
affects:
  - SpendGovernor retry policy (verification_failed code is now actually emitted)
  - post-run forensics (run-ledger.json gains entries for failed rubric verdicts)
tech-stack:
  added: []
  patterns:
    - best-effort ledger escalation (try/catch, never re-throw, swallowed on error)
    - module-level getActiveLedger() singleton pattern (avoids plumbing ledger through executePhaseSafe signature)
    - exactOptionalPropertyTypes-safe spread for optional `model` field
key-files:
  created:
    - (none)
  modified:
    - src/orchestrator.ts — split satisfied||failed branch; new failed branch invokes recordFailure
    - src/evaluation/evaluate-loop.ts — new escalateRubricFailureToLedger() helper + two call sites
    - tests/integration/orchestrator.test.ts — +2 integration tests (HIGH-01 coverage)
    - .planning/phases/03-high-priority-runtime-fixes/deferred-items.md — log pre-existing flakes re-observed
decisions:
  - "Use getActiveLedger() module singleton instead of plumbing ledger through executePhaseSafe() — matches existing setActiveLedger(ledger) call at runOrchestrator startup, keeps executePhaseSafe signature stable, and silently no-ops in unit tests that don't bootstrap an orchestrator."
  - "Session type for rubric escalation is \"rubric\" (already in SessionTypeSchema), not \"coordinator\" — keeps spend attribution buckets honest."
  - "Reason code is exactly the canonical \"verification_failed\" from failure-codes.ts — enables SpendGovernor's verification_failed retry policy (tests/governance/spend-governor.test.ts:108-117) to finally trigger."
  - "Escalation is best-effort: wrapped in try/catch, errors logged via console.warn + errMsg(), never re-thrown. A ledger failure MUST NOT mask the actual phase outcome being reported."
metrics:
  duration: "~64 minutes"
  completed: "2026-04-22"
  tasks: 4
  files_modified: 4
  tests_added: 2
---

# Phase 03 Plan 01: HIGH-01 rubric feedback loop + ledger escalation — Summary

## One-liner

Wired the rubric feedback loop end-to-end so `needs_revision` re-invokes the phase handler with gap-feedback and `failed` escalates to `RunLedger` as `verification_failed` — including parity in the standalone `evaluateWithRubric()` helper and two regression tests.

## What was built

### Edit 1 — `src/orchestrator.ts` (lines ~826-828 split + new escalation block)

**Import change (line 42):**
```diff
-import { RunLedger, setActiveLedger } from "./state/run-ledger.js";
+import { RunLedger, setActiveLedger, getActiveLedger } from "./state/run-ledger.js";
```

**Rubric-loop branch split (was one combined conditional; now two):**
```diff
-          if (rubricResult.verdict === "satisfied" || rubricResult.verdict === "failed") {
-            return { ...iterResult, costUsd: rubricCost, rubricResult };
-          }
+          if (rubricResult.verdict === "satisfied") {
+            return { ...iterResult, costUsd: rubricCost, rubricResult };
+          }
+          if (rubricResult.verdict === "failed") {
+            // HIGH-01: escalate failed rubric verdict to RunLedger with the
+            // canonical `verification_failed` reason code. Best-effort — a
+            // ledger error must not mask the actual phase outcome being
+            // returned to the caller.
+            try {
+              const activeLedger = getActiveLedger();
+              if (activeLedger) {
+                const graderModel =
+                  config.rubrics?.graderModel ?? config.subagentModel;
+                const session = activeLedger.startSession({
+                  phase,
+                  role: "rubric-grader",
+                  sessionType: "rubric",
+                  ...(graderModel ? { model: graderModel } : {}),
+                });
+                const failureMessage =
+                  rubricResult.summary && rubricResult.summary.trim().length > 0
+                    ? rubricResult.summary
+                    : `Rubric "${rubric.name}" failed at iteration ${iter} with overall score ${rubricResult.overallScore.toFixed(2)}`;
+                activeLedger.recordFailure(
+                  session.sessionId,
+                  "verification_failed",
+                  failureMessage,
+                );
+                activeLedger.endSession(session.sessionId, { success: false });
+                console.log(
+                  `[ledger] verification_failed recorded for phase "${phase}" (rubric "${rubric.name}", score ${rubricResult.overallScore.toFixed(2)})`,
+                );
+              }
+            } catch (err) {
+              console.warn(
+                `[ledger] Failed to record verification_failed escalation for phase "${phase}": ${errMsg(err)}`,
+              );
+            }
+            return { ...iterResult, costUsd: rubricCost, rubricResult };
+          }
```

Note: the `needs_revision` retry path immediately below is byte-for-byte unchanged (the plan's verification requirement).

Commit: `32b2b44` — `feat(03-01): escalate failed rubric verdict to RunLedger as verification_failed`

### Edit 2 — `src/evaluation/evaluate-loop.ts` (imports + helper + 2 call sites)

**Imports + new private helper at top of file:**
```diff
 import { gradePhaseOutput } from "./grader.js";
+import { getActiveLedger } from "../state/run-ledger.js";
+import { errMsg } from "../utils/shared.js";
+
+/**
+ * HIGH-01: Best-effort escalation of a `failed` rubric verdict into the active
+ * RunLedger with reason code `verification_failed`. No-op if no ledger is set
+ * (e.g. unit tests that don't bootstrap an orchestrator). Errors are swallowed
+ * — a ledger failure must never mask the actual phase outcome being reported.
+ */
+function escalateRubricFailureToLedger(
+  phase: Phase | undefined,
+  rubric: Rubric,
+  rubricResult: RubricResult,
+  config: Config,
+): void {
+  if (!phase) return;
+  try {
+    const ledger = getActiveLedger();
+    if (!ledger) return;
+    const graderModel = config.rubrics?.graderModel ?? config.subagentModel;
+    const session = ledger.startSession({
+      phase,
+      role: "rubric-grader",
+      sessionType: "rubric",
+      ...(graderModel ? { model: graderModel } : {}),
+    });
+    const message =
+      rubricResult.summary && rubricResult.summary.trim().length > 0
+        ? rubricResult.summary
+        : `Rubric "${rubric.name}" failed at iteration ${rubricResult.iteration} with overall score ${rubricResult.overallScore.toFixed(2)}`;
+    ledger.recordFailure(session.sessionId, "verification_failed", message);
+    ledger.endSession(session.sessionId, { success: false });
+    console.log(
+      `[ledger] verification_failed recorded for phase "${phase}" (rubric "${rubric.name}")`,
+    );
+  } catch (err) {
+    console.warn(
+      `[ledger] Failed to record verification_failed escalation: ${errMsg(err)}`,
+    );
+  }
+}
```

**Call site (a) — `!phaseResult.success` path (synthetic failed verdict when handler itself fails):**
```diff
-      return {
-        ...phaseResult,
-        costUsd: totalCost,
-        rubricResult: {
-          rubricName: rubric.name,
-          scores: [],
-          verdict: "failed",
-          overallScore: 0,
-          summary: `Phase handler failed: ${phaseResult.error ?? "unknown error"}`,
-          iteration,
-        },
-        totalIterations: iteration,
-      };
+      const syntheticFailedResult: RubricResult = {
+        rubricName: rubric.name,
+        scores: [],
+        verdict: "failed",
+        overallScore: 0,
+        summary: `Phase handler failed: ${phaseResult.error ?? "unknown error"}`,
+        iteration,
+      };
+      escalateRubricFailureToLedger(phase, rubric, syntheticFailedResult, config);
+      return {
+        ...phaseResult,
+        costUsd: totalCost,
+        rubricResult: syntheticFailedResult,
+        totalIterations: iteration,
+      };
```

**Call site (b) — graded `satisfied || failed` path (split to fire helper only on failed):**
```diff
     if (rubricResult.verdict === "satisfied" || rubricResult.verdict === "failed") {
       if (phase !== undefined) {
         eventBus?.emit("evaluation.rubric.end", {
           phase,
           rubricName: rubric.name,
           result: rubricResult.verdict,
           iteration,
         });
       }
+      if (rubricResult.verdict === "failed") {
+        escalateRubricFailureToLedger(phase, rubric, rubricResult, config);
+      }
       return {
```

Commit: `07a7519` — `feat(03-01): mirror failed-verdict ledger escalation in evaluateWithRubric()`

### Edit 3 — `tests/integration/orchestrator.test.ts` (+2 tests)

Appended inside the existing `describe("Orchestrator", ...)` block, after the last pre-existing test:

1. **`rubric verdict 'failed' escalates to ledger as verification_failed (HIGH-01)`**
   - Mocks `gradePhaseOutput` to return `verdict: "failed"` on iteration 1.
   - Bootstraps `runOrchestrator(state, config, undefined, "architecture")`.
   - Loads the persisted `ledger/<runId>.json` snapshot.
   - Asserts at least one `sessionType === "rubric"` session exists.
   - Asserts at least one failure has `reasonCode === "verification_failed"`.

2. **`rubric verdict 'needs_revision' re-runs handler with rubricFeedback injected (HIGH-01)`**
   - Mocks `gradePhaseOutput` to return `needs_revision` → `satisfied`.
   - Uses `mockedRunArchitecture.mockImplementation((_s, _c, execCtx) => capturedCtxs.push(execCtx?.context))`.
   - Asserts the handler is called twice, first call has `rubricFeedback === undefined`, second call has `rubricFeedback` containing both `"Rubric Feedback"` and the failing criterion name `"scalability_addressed"`.

Commit: `7e55979` — `test(03-01): add HIGH-01 rubric feedback loop integration tests`

## Verification

### Grep counts for `verification_failed` (plan verification §603-605)

| File | Count | Required |
|------|------:|:---------|
| `src/orchestrator.ts` | **4** | ≥ 1 |
| `src/evaluation/evaluate-loop.ts` | **4** | ≥ 1 |
| `tests/integration/orchestrator.test.ts` | **2** | ≥ 1 |

### Structural invariants

- ✅ `grep -cE 'recordFailure\(.*verification_failed' src/orchestrator.ts` → 1 call site
- ✅ `grep -c 'escalateRubricFailureToLedger' src/evaluation/evaluate-loop.ts` → 3 (1 definition + 2 call sites)
- ✅ `needs_revision` retry path in `orchestrator.ts` (`rubricFeedback = "## Rubric Feedback …"` block at lines ~832-840 after split) is byte-for-byte unchanged outside the split conditional.

### Tooling

- ✅ `npm run typecheck` — exit 0, clean (strict-mode types hold)
- ✅ `npm run lint` — exit 0 (0 errors; 1 warning in `src/phases/development-runner.ts` is from another plan's committed work, not HIGH-01)
- ✅ `npm test -- --run tests/integration/orchestrator.test.ts tests/integration/rubric-feedback.test.ts tests/evaluation/evaluate-loop.test.ts` → **25/25** passing (scope-complete verification of HIGH-01-impacted test files)
- ✅ `npm test -- --run tests/integration/orchestrator.test.ts` → **10/10** passing (was 8, +2 HIGH-01 tests)

### Baseline

- Plan start baseline: **811/811** passing.
- Post-HIGH-01 scope: both new tests pass, **25/25** in the direct-impact test set. Full-suite runs show +2 new tests landed from this plan; interleaving with parallel plans makes direct 811→813 arithmetic impossible to assert as a single number, but the delta (+2 passing tests from HIGH-01 alone) is verified via the direct-impact test set.

## Deviations from Plan

### Auto-fixed (Rule 1 — type-correctness pass)

**1. [Rule 1 — Bug] `exactOptionalPropertyTypes`-compliant `model` spread**
- **Found during:** Task 1 (orchestrator edit).
- **Issue:** The plan's template-action code uses
  `model: graderModel` directly inside `startSession({ ... })`. Under strict
  `exactOptionalPropertyTypes` with `graderModel: string | undefined`, this
  passes `undefined` where `model?: string` expects the key absent — TS2412.
- **Fix:** Used conditional spread `...(graderModel ? { model: graderModel } : {})`
  to match the rest of the codebase's exactOptionalPropertyTypes-safe pattern.
- **Files modified:** `src/orchestrator.ts`, `src/evaluation/evaluate-loop.ts`.
- **Commits:** `32b2b44`, `07a7519`.

**2. [Rule 1 — Bug] `summary?.trim().length` truthy check with `> 0`**
- **Found during:** Task 1 (orchestrator edit).
- **Issue:** The plan's template uses
  `rubricResult.summary?.trim().length ? rubricResult.summary : <fallback>`.
  Under `noUncheckedIndexedAccess` + strict-mode falsy rules, the optional-chain
  can short-circuit to `undefined` which is correctly falsy, but explicit
  `> 0` compare is clearer and avoids the eslint `@typescript-eslint/prefer-nullish-coalescing`
  diagnostic on sibling expressions.
- **Fix:** Explicit `rubricResult.summary && rubricResult.summary.trim().length > 0`.
- **Files modified:** `src/orchestrator.ts`, `src/evaluation/evaluate-loop.ts`.
- **Commits:** `32b2b44`, `07a7519`.

### Auto-fixed (Rule 3 — test type safety)

**3. [Rule 3 — Blocking] Integration-test type safety for ledger snapshot**
- **Found during:** Task 3 (test authoring).
- **Issue:** The plan's template uses
  `const ledgerPath = join(ledgerDir, files[0]!);` and an untyped
  `JSON.parse(...)` cast, then `.filter((s: { sessionType: string }) => ...)`
  on `ledgerSnapshot.sessions ?? []`. Under `noUncheckedIndexedAccess`, `files[0]`
  is `string | undefined`; under strict-mode `JSON.parse` return is `any` but
  the inline `{ sessionType: string }` annotation breaks flatMap's failure-array
  type inference.
- **Fix:** Used `expect(firstLedgerFile).toBeDefined()` to narrow, cast
  `firstLedgerFile as string` at the `join` call, and declared a single
  explicit type for the snapshot shape with `failures: Array<{ reasonCode: string; message: string }>`
  so flatMap infers cleanly.
- **Files modified:** `tests/integration/orchestrator.test.ts`.
- **Commit:** `7e55979`.

### Not fixed (out of scope — deferred)

**4. [Out of scope] Pre-existing flaky tests re-observed during verification**

Full-suite runs of `npm test` show occasional timing-based failures in:
- `tests/events/interrupter.test.ts > signal aborts in-flight consumeQuery within 100ms` — `100ms` budget exceeded under parallel load.
- `tests/integration/pipeline.test.ts > runs ideation → specification → architecture → environment-setup` — `Test timed out in 5000ms`.
- `tests/integration/orchestrator.test.ts > runs through ideation → specification → architecture` (pre-existing test, **NOT** one I added) — intermittent `Test timed out in 5000ms`.

All three tests pass in isolation and were already flagged in
`.planning/phases/03-high-priority-runtime-fixes/deferred-items.md` during
Plans 03-02, 03-04, and 03-05. Confirmed non-caused by HIGH-01 (no timing code
or SDK/IO touched). Deferred-items.md updated with a "Re-observed during HIGH-01"
section linking the 01-SUMMARY.

## Key decisions

- **Use `getActiveLedger()` singleton, not parameter plumbing.** Rationale: `setActiveLedger(ledger)` is already called at `runOrchestrator()` startup (line 264). Adding a ledger param to `executePhaseSafe` would force every test to construct a fake ledger. Best-effort lookup lets unit tests skip silently.
- **Session type is `"rubric"`**, not `"coordinator"`. Rationale: `SessionTypeSchema` already reserves `"rubric"` for this exact use case; reusing `"coordinator"` would pollute the coord/impl/aux spend-ratio analysis.
- **Reason code is exactly `"verification_failed"`.** Rationale: canonical `CanonicalFailureReasonCode`. Opens the door for `SpendGovernor`'s `verification_failed` retry policy to activate for the first time.
- **Escalation is best-effort (try/catch + console.warn + never re-throw).** Rationale: observability infrastructure must never mask correctness signals. If the ledger errors, the actual phase outcome still propagates to the caller.
- **`evaluate-loop.ts` escalates BOTH synthetic-failed (handler crash) AND graded-failed (verdict)** paths. Rationale: both land in the same terminal "failed" state; operators need ledger entries for both so forensic queries like "which phases were rejected by the rubric?" return a complete set.

## Self-Check

Verified after writing this SUMMARY:

### Created files exist

```
$ [ -f ".planning/phases/03-high-priority-runtime-fixes/01-SUMMARY.md" ] && echo FOUND
FOUND
```

### Commits exist

```
$ git log --oneline --all | grep -qE "32b2b44|07a7519|7e55979" && echo FOUND
FOUND
```

Commits verified:
- `32b2b44` — `feat(03-01): escalate failed rubric verdict to RunLedger as verification_failed`
- `07a7519` — `feat(03-01): mirror failed-verdict ledger escalation in evaluateWithRubric()`
- `7e55979` — `test(03-01): add HIGH-01 rubric feedback loop integration tests`

## Self-Check: PASSED
