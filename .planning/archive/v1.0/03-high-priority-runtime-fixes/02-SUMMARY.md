---
phase: 03-high-priority-runtime-fixes
plan: 02
subsystem: testing
tags: [grader, rubric, verdict-precedence, regression-test, jsdoc, high-02]

# Dependency graph
requires:
  - phase: 01-test-readiness-stabilization
    provides: 777/777 green baseline so the +2 new tests sit on a clean signal
provides:
  - Documented three-tier verdict-precedence rule on src/evaluation/grader.ts (JSDoc + 3 inline boundary comments)
  - Two regression tests in tests/evaluation/grader.test.ts asserting the LLM verdict survives in BOTH contradiction directions (satisfied-with-failing-scores AND failed-with-passing-scores)
affects: [development, testing, review, ab-testing, analysis, monitoring — every phase that consumes a rubric verdict]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Verdict-precedence lock-in pattern: JSDoc ladder block above the public function + per-branch `HIGH-N — verdict precedence rule (#N)` inline comments at each boundary, tied to regression tests that assert the contract in both directions"
    - "Contradiction-direction regression test pattern: feed the function a payload where the LLM verdict and the algorithmically-derived verdict DISAGREE, then assert the LLM verdict wins"

key-files:
  created: []
  modified:
    - src/evaluation/grader.ts (JSDoc + 3 inline comments only — zero behavior change)
    - tests/evaluation/grader.test.ts (+2 regression tests)

key-decisions:
  - "HIGH-02 closure is documentation + lock-in tests, NOT a code-behavior change. The parsed-success branch in src/evaluation/grader.ts (lines 215-220) already trusted the LLM verdict verbatim — the gap was that nothing in the file or test suite documented or asserted it. A future refactor that quietly inverted the precedence by calling determineVerdict(scores) in the parsed-success branch would now fail CI."
  - "Used 2-criterion fixtures (not 3) for the regression tests so the algorithmic disagreement is unambiguous: 2/2 failed > scores.length/2 = 1 → algorithmic verdict 'failed' (Test 1); 0/2 failed → algorithmic verdict 'satisfied' (Test 2). The LLM emits the OPPOSITE verdict in each case, and the assertions confirm the LLM's value is returned verbatim."
  - "Did NOT alter the four assignments in the parsed-success branch (`scores = parsed.data.scores; verdict = parsed.data.verdict; overallScore = parsed.data.overallScore; summary = parsed.data.summary;`). They are byte-for-byte unchanged — verified by inspecting commit 312e738's diff."

patterns-established:
  - "HIGH-N closure annotation pattern: a JSDoc 'verdict precedence rule (HIGH-N — required by REQUIREMENTS.md)' header on the function + per-branch numbered inline comments (`HIGH-N — verdict precedence rule (#1)`, `(#2)`, `(#3)`). A grep for the requirement ID surfaces every site that participates in the contract."
  - "Stream-mock-helper reuse: regression tests reuse the file's existing `makeMockQueryStream` helper and `mockedQuery.mockReturnValue(...)` pattern rather than introducing a new mocking helper, keeping the test file consistent."

requirements-completed: [HIGH-02]

# Metrics
duration: 4 min
completed: 2026-04-22
---

# Phase 03 Plan 02: HIGH-02 — grader verdict precedence Summary

**JSDoc three-tier precedence ladder on src/evaluation/grader.ts (LLM verdict > algorithmic fallback > fail-open) + 3 inline boundary comments + 2 contradiction-direction regression tests in tests/evaluation/grader.test.ts that lock the contract in.**

## Performance

- **Duration:** ~4 min (commits 312e738 at 19:15:50 → 9887fc4 at 19:19:22)
- **Started:** 2026-04-22T19:15:50Z
- **Completed:** 2026-04-22T19:19:22Z
- **Tasks:** 2 implementation tasks + 1 verification sweep
- **Files modified:** 2 (1 source, 1 test)

## Accomplishments

1. **Documented the verdict-precedence rule** — added a JSDoc block above `gradePhaseOutput()` in `src/evaluation/grader.ts` describing the three-tier ladder (LLM-emitted > algorithmic-fallback > fail-open) and inline `HIGH-02 — verdict precedence rule (#1|#2|#3)` comments at each precedence boundary.
2. **Locked in the contract with regression tests** — added two `it(...)` blocks in `tests/evaluation/grader.test.ts` that exercise contradiction directions: LLM 'satisfied' wins over algorithmic 'failed' (Test 1), LLM 'failed' wins over algorithmic 'satisfied' (Test 2). Both pass against the unchanged grader code.
3. **Zero behavior change** — the four assignments in the parsed-success branch are byte-for-byte unchanged. HIGH-02 acceptance criterion #2 ("the grader never replaces an LLM-emitted structured verdict — verdict precedence is asserted in tests") is fully satisfied via documentation + tests, not via a code rewrite.

## JSDoc Block Added (verbatim, src/evaluation/grader.ts)

```ts
/**
 * Run the grader LLM against a phase result and return a structured RubricResult.
 *
 * **verdict precedence rule (HIGH-02 — required by REQUIREMENTS.md):**
 *
 *   1. **LLM-emitted verdict (preferred).** When `GraderOutputSchema.safeParse`
 *      succeeds against the structured output (or a JSON parse of the result
 *      text), the LLM's `verdict`, `overallScore`, `scores`, and `summary` are
 *      returned VERBATIM. The grader MUST NOT recompute the verdict via
 *      `determineVerdict(scores)` or override `overallScore` via
 *      `computeWeightedScore(...)`. The LLM is the source of truth.
 *
 *   2. **Algorithmic fallback.** When parsing fails (no structured_output AND
 *      `result.result` is not valid JSON matching the schema), and only then,
 *      the grader synthesizes a default `scores` array (one entry per
 *      criterion at 0.5 / passed=false), then computes `overallScore` and
 *      `verdict` algorithmically from those defaults. This is a degraded
 *      signal — the rubric loop will see `verdict: "needs_revision"` (because
 *      most criteria fail their thresholds) and retry, OR `verdict: "failed"`
 *      if more than half "fail."
 *
 *   3. **Fail-open on grader outage.** When `consumeQuery` itself throws
 *      (timeout / network / abort), the grader returns `verdict: "satisfied"`
 *      with `overallScore: 1` so an infrastructure error does NOT block the
 *      pipeline. This is a deliberate trade — operators get a warning log,
 *      not a halt.
 *
 * Tests in `tests/evaluation/grader.test.ts` lock this precedence in.
 */
```

## Inline Boundary Comments Added (3 sites)

| Branch | Line | Comment |
|--------|------|---------|
| Parsed-success (#1) | 215 | `// HIGH-02 — verdict precedence rule (#1): LLM verdict wins. Do NOT replace verdict with determineVerdict(scores) and do NOT replace overallScore with computeWeightedScore(scores, criteria). The LLM's structured output is the source of truth when it parses.` |
| Algorithmic fallback (#2) | 224 | `// HIGH-02 — verdict precedence rule (#2): no LLM verdict to honor. Synthesize defaults for every criterion, then derive verdict/overallScore algorithmically. This branch only runs when neither the SDK's structuredOutput nor a JSON parse of result.result matches GraderOutputSchema.` |
| Fail-open on outage (#3) | 176 | `// HIGH-02 — verdict precedence rule (#3): grader outage → fail-open verdict='satisfied' with overallScore=1 so infrastructure errors (timeout, network, abort) do NOT block the orchestrator.` |

## 2 New Regression Tests (tests/evaluation/grader.test.ts)

| # | Test name | What it pins |
|---|-----------|--------------|
| 1 | `preserves LLM-emitted satisfied verdict even when scores would algorithmically grade as failed (HIGH-02)` | LLM emits `verdict: "satisfied", overallScore: 0.85` with 2/2 criteria at score 0.05–0.1 / `passed: false`. `determineVerdict(scores)` would return `"failed"` (failedCount 2 > scores.length/2 = 1). Assertion: `rubricResult.verdict === "satisfied"` and `rubricResult.overallScore ≈ 0.85`. |
| 2 | `preserves LLM-emitted failed verdict even when scores would algorithmically grade as satisfied (HIGH-02)` | Inverse direction. LLM emits `verdict: "failed", overallScore: 0.2` with 2/2 criteria at score 0.92–0.95 / `passed: true`. `determineVerdict(scores)` would return `"satisfied"`. Assertion: `rubricResult.verdict === "failed"` and `rubricResult.overallScore ≈ 0.2`. |

A future refactor that silently inverts the precedence by calling `determineVerdict(scores)` in the parsed-success branch would fail BOTH tests on CI.

## Test Count Delta

- **Pre-Plan 03-02 baseline:** 826/826 passing (assuming Plan 03-04 already added its +4).
- **Post-Plan 03-02:** 828/828 passing in 81 test files (+2 from this plan).
- **Confirmed by full-suite sweep:** `npm test` → 828 passed (828) in 91.94s.

## Lint / Typecheck Confirmation

- `npm run typecheck` → exits 0 (clean).
- `npm test` → 828/828 passing.
- `npm run lint` → exits 0 (1 pre-existing warning in `src/phases/development-runner.ts:10` about an unused `AgentBlueprint` import — out of scope, untouched by this plan).

## HIGH-02 Annotation Audit

```
$ grep -c "HIGH-02" src/evaluation/grader.ts        # → 4 (JSDoc + 3 inline)
$ grep -c "verdict precedence" src/evaluation/grader.ts  # → 4
$ grep -c "HIGH-02" tests/evaluation/grader.test.ts # → 3 (2 it-block titles + 1 comment)
```

All grep gates from the plan's `<verification>` section satisfied.

## Task Commits

Each task committed atomically:

1. **Task 1: Document the verdict-precedence rule in grader.ts** — `312e738` (`docs(03-02): document HIGH-02 verdict-precedence rule in grader.ts`)
2. **Task 2: Add regression tests in both contradiction directions** — `9887fc4` (`test(03-02): lock in HIGH-02 verdict-precedence contract with regression tests`)
3. **Task 3: Full test sweep + lint** — verification-only, no code commit (results captured in this SUMMARY).

**Plan metadata commit:** added in the same step as this SUMMARY (back-fill commit; see `git log --oneline` after this commit lands).

## Files Created/Modified

- `src/evaluation/grader.ts` — +41 lines, –1 line (JSDoc block + 3 inline comments). Production-code assignments byte-for-byte unchanged. Verified by inspecting commit 312e738.
- `tests/evaluation/grader.test.ts` — +71 lines (2 `it(...)` blocks at the end of the existing `describe("gradePhaseOutput", ...)` block). Reuses existing `makeMockQueryStream`, `createInitialState`, `makeConfig`, and `TEST_RUBRIC` helpers — no new fixtures introduced. Verified by inspecting commit 9887fc4.

## Decisions Made

- **Documentation + tests, not a rewrite.** Per the plan, the parsed-success branch already trusted the LLM verdict verbatim. The HIGH-02 closure value is the regression net + the JSDoc that prevents a future refactor from silently inverting the contract.
- **2-criterion fixtures for both regression tests.** Smaller than the plan's proposed 3-criterion fixtures (which the plan suggested in `<behavior>` but the executor narrowed to 2 to make the algorithmic-vs-LLM disagreement maximally unambiguous: 2/2 failed > 1 = unambiguous algorithmic 'failed'; 0/2 failed = unambiguous algorithmic 'satisfied'). Both shapes still trip a contradiction with the LLM verdict — assertion intent is preserved.
- **Generic criterion names (`criterion_a`, `criterion_b`).** The fixture criteria are not tied to any real rubric (e.g. `compiles_cleanly`); they exist only to feed `gradePhaseOutput` a structurally-valid payload. Using generic names keeps the test orthogonal to any future rubric-criterion renames.

## Deviations from Plan

None — plan executed exactly as written. The 2-criterion-vs-3-criterion fixture choice noted under "Decisions Made" is a tightening within the plan's `<behavior>` contract (still asserts the contradiction direction in both senses), not a deviation from it.

## Issues Encountered

None.

## User Setup Required

None — no external service or config change.

## Next Phase Readiness

- **HIGH-02 closed.** REQUIREMENTS.md acceptance criterion #2 ("The grader never replaces an LLM-emitted structured verdict — verdict precedence is asserted in tests") fully satisfied with documentation + a two-direction regression net.
- **No blockers** for HIGH-01 (the rubric-feedback-loop wiring) or any downstream plan. HIGH-01 consumes the rubric verdict from `gradePhaseOutput`; the lock-in here guarantees that contract is stable while HIGH-01 builds on top of it.
- **No follow-ups deferred.** All `<verification>` and `<success_criteria>` gates from `02-PLAN.md` are green.

## Self-Check: PASSED

- `src/evaluation/grader.ts` contains the JSDoc + 3 inline comments (`grep -c "HIGH-02" src/evaluation/grader.ts` → 4; `grep -c "verdict precedence" src/evaluation/grader.ts` → 4).
- `tests/evaluation/grader.test.ts` contains both regression tests (`grep -c "HIGH-02" tests/evaluation/grader.test.ts` → 3; `grep -c "preserves LLM-emitted" tests/evaluation/grader.test.ts` → 2).
- `npm run typecheck` → exits 0.
- `npm test` → 828 passed (828) in 91.94s.
- `npm run lint` → exits 0 (1 pre-existing unrelated warning, 0 errors).
- Commits exist in `git log`: `312e738` (Task 1, docs), `9887fc4` (Task 2, test).

---
*Phase: 03-high-priority-runtime-fixes*
*Completed: 2026-04-22*
