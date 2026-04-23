---
phase: 03-high-priority-runtime-fixes
plan: 02
type: execute
wave: 1
depends_on: []
files_modified:
  - src/evaluation/grader.ts
  - tests/evaluation/grader.test.ts
autonomous: true
requirements:
  - HIGH-02
must_haves:
  truths:
    - "When the grader's structured output parses successfully via GraderOutputSchema.safeParse, the LLM-emitted verdict, scores, and overallScore are returned VERBATIM — no recomputation, no override"
    - "When the grader's structured output FAILS to parse (fallback path), the verdict is computed from the per-criterion default scores via determineVerdict() and the rationale is documented in code via a /** verdict precedence */ JSDoc block"
    - "The fail-open path (consumeQuery throws) returns verdict='satisfied' explicitly to AVOID blocking on infrastructure errors; this is the documented precedence rule for the no-output path"
    - "A new test asserts that even when the LLM emits a 'satisfied' verdict alongside scores that would algorithmically grade to 'failed' (>50% below threshold), the LLM's 'satisfied' verdict is preserved (because the LLM is the source of truth when structured output parses)"
    - "A new test asserts the inverse: an LLM-emitted 'failed' verdict with all-passing scores is also preserved verbatim"
    - "npm run typecheck exits 0"
    - "npm test exits 0 (preserves 811/811 baseline; new tests add to the count)"
    - "npm run lint exits 0"
  artifacts:
    - path: "src/evaluation/grader.ts"
      provides: "gradePhaseOutput() with documented verdict-precedence rule and an assertion that the LLM verdict is never overwritten when parsing succeeds"
      contains: "verdict precedence"
    - path: "tests/evaluation/grader.test.ts"
      provides: "Two new tests asserting LLM-verdict precedence in both directions (satisfied-with-failing-scores and failed-with-passing-scores)"
      contains: "LLM-emitted verdict"
  key_links:
    - from: "src/evaluation/grader.ts (parsed.success branch, line ~182-186)"
      to: "the four return fields { scores, verdict, overallScore, summary }"
      via: "verbatim assignment from parsed.data — no determineVerdict / no computeWeightedScore call"
      pattern: "verdict = parsed\\.data\\.verdict"
---

<objective>
HIGH-02: Document and assert the grader's verdict-precedence rule. Today the parsed-success branch in `src/evaluation/grader.ts` (lines ~182-186) DOES correctly trust the LLM's `verdict` and `overallScore` verbatim — but the rule is not documented anywhere, there is no test asserting the LLM's verdict overrides any algorithmically-computed value, and the fallback branch (lines ~188-199) silently overrides via `computeWeightedScore` + `determineVerdict`. A future refactor could quietly invert the precedence and break the contract HIGH-02 calls out.

Purpose: Per REQUIREMENTS.md HIGH-02 success criterion #2: "The grader never replaces an LLM-emitted structured verdict — verdict precedence is asserted in tests." The audit gap is two-fold: (a) no JSDoc / inline comment in `grader.ts` explains the precedence ladder (parsed-LLM > algorithmic-fallback > fail-open-satisfied), and (b) `tests/evaluation/grader.test.ts` has no test that exercises an LLM verdict that *contradicts* what `determineVerdict(scores)` would algorithmically compute. The mitigation is documentation + two regression tests; no behavioral code change is needed in the parsed-success path.

Output: One small documentation edit in `src/evaluation/grader.ts` (a JSDoc block above `gradePhaseOutput` and inline comments at the precedence boundaries), plus two new tests in `tests/evaluation/grader.test.ts`.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/REQUIREMENTS.md
@.planning/phases/03-high-priority-runtime-fixes/03-CONTEXT.md
@.claude/skills/typescript/SKILL.md
@src/evaluation/grader.ts
@src/evaluation/rubric.ts
@tests/evaluation/grader.test.ts

<interfaces>
<!-- Key contracts the executor needs. Extracted from codebase. -->

From src/evaluation/rubric.ts:
```typescript
export function determineVerdict(scores: CriterionScore[]): "satisfied" | "needs_revision" | "failed" {
  const failedCount = scores.filter(s => !s.passed).length;
  if (failedCount > scores.length / 2) return "failed";
  if (failedCount === 0) return "satisfied";
  return "needs_revision";
}
```
This is the **algorithmic** verdict. The LLM verdict (when parsed) MUST take precedence.

From src/evaluation/grader.ts (current parsed-success branch, lines 182-186):
```typescript
if (parsed.success) {
  scores = parsed.data.scores;
  verdict = parsed.data.verdict;        // ← THIS is the LLM verdict — must NOT be overwritten
  overallScore = parsed.data.overallScore; // ← THIS too — must NOT be recomputed
  summary = parsed.data.summary;
}
```

From src/evaluation/grader.ts (current fallback branch, lines 188-199):
```typescript
} else {
  // Fallback: construct minimal result from text
  console.warn("[grader] Failed to parse structured output, using fallback scoring");
  scores = rubric.criteria.map(c => ({
    criterionName: c.name,
    score: 0.5,
    passed: false,
    feedback: "Could not evaluate — grader output was not structured",
  }));
  overallScore = computeWeightedScore(scores, rubric.criteria);
  verdict = determineVerdict(scores);   // ← Algorithmic fallback — only used when there is NO LLM verdict to honor
  summary = result.result.slice(0, 500);
}
```

From src/evaluation/grader.ts (current fail-open branch, lines 142-164):
```typescript
} catch (err) {
  // ... grader query itself failed (network/timeout)
  // returns verdict: "satisfied" so a grader outage doesn't block the run
  return {
    rubricResult: {
      // ...
      verdict: "satisfied",
      overallScore: 1,
      summary,
      iteration: 0,
    },
    costUsd: 0,
  };
}
```

From tests/evaluation/grader.test.ts (existing patterns to mirror):
- The file already has helper for streaming a fake grader response with structured_output (similar to `makeGraderStream` in `tests/integration/rubric-feedback.test.ts`).
- Existing test `"trusts LLM-provided verdict and score when parsing succeeds"` (line 164) asserts that the LLM verdict is returned, but only with a self-consistent score set. It does NOT exercise an LLM verdict that contradicts `determineVerdict(scores)`. The new tests close that gap.
- Existing test `"falls back gracefully when structured output parsing fails"` (line 131) — leave this untouched; it covers the fallback branch already.
- Existing test `"fails open when grader query errors"` (line 221) — leave untouched; covers the fail-open branch.
</interfaces>

<notes_for_executor>
1. **No behavioral change in the parsed-success path**: the contract that the LLM's verdict is preserved verbatim is ALREADY satisfied by the code (lines 182-186). This plan documents the rule and adds tests that lock it in.
2. **Do not extract `escalateRubricFailureToLedger` into grader.ts** — that escalation lives in HIGH-01 (Plan 01) inside orchestrator.ts and evaluate-loop.ts. grader.ts must stay pure (no ledger side-effects).
3. **The two new tests must use ABSURD score sets** that would algorithmically grade to the OPPOSITE of the LLM verdict — that's the whole point. e.g. LLM says "satisfied" but ALL scores fail their thresholds. With current code, the LLM verdict wins; the test asserts that.
4. **TypeScript strict** — see `.claude/skills/typescript/SKILL.md`. Optional fields use `noUncheckedIndexedAccess`; assertions on `.scores[0]` need narrowing or non-null with `!`.
5. **No new exports** — the JSDoc and inline comments are documentation only.
</notes_for_executor>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Document the verdict-precedence rule in grader.ts</name>
  <files>src/evaluation/grader.ts</files>
  <action>
**Edit 1 — Add a JSDoc block above the `gradePhaseOutput` function (currently around line 108):**

Before:
```ts
export interface GraderOptions {
  model?: string;
  config: Config;
  eventBus?: EventBus;
  phase?: Phase;
  signal?: AbortSignal;
}

export async function gradePhaseOutput(
  rubric: Rubric,
  phaseResult: PhaseResult,
  state: ProjectState,
  options: GraderOptions,
): Promise<{ rubricResult: RubricResult; costUsd: number }> {
```

After:
```ts
export interface GraderOptions {
  model?: string;
  config: Config;
  eventBus?: EventBus;
  phase?: Phase;
  signal?: AbortSignal;
}

/**
 * Run the grader LLM against a phase result and return a structured RubricResult.
 *
 * **Verdict precedence rule (HIGH-02 — required by REQUIREMENTS.md):**
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
export async function gradePhaseOutput(
  rubric: Rubric,
  phaseResult: PhaseResult,
  state: ProjectState,
  options: GraderOptions,
): Promise<{ rubricResult: RubricResult; costUsd: number }> {
```

**Edit 2 — Add an inline comment at the parsed-success branch (currently around lines 182-186):**

Before:
```ts
  if (parsed.success) {
    scores = parsed.data.scores;
    verdict = parsed.data.verdict;
    overallScore = parsed.data.overallScore;
    summary = parsed.data.summary;
  } else {
```

After:
```ts
  if (parsed.success) {
    // HIGH-02 — verdict precedence rule (#1): LLM verdict wins.
    // Do NOT replace `verdict` with `determineVerdict(scores)` and do NOT
    // replace `overallScore` with `computeWeightedScore(scores, criteria)`.
    // The LLM's structured output is the source of truth when it parses.
    scores = parsed.data.scores;
    verdict = parsed.data.verdict;
    overallScore = parsed.data.overallScore;
    summary = parsed.data.summary;
  } else {
```

**Edit 3 — Add an inline comment at the algorithmic fallback branch (currently around lines 188-199):**

Before:
```ts
  } else {
    // Fallback: construct minimal result from text
    console.warn("[grader] Failed to parse structured output, using fallback scoring");
    scores = rubric.criteria.map(c => ({
      criterionName: c.name,
      score: 0.5,
      passed: false,
      feedback: "Could not evaluate — grader output was not structured",
    }));
    overallScore = computeWeightedScore(scores, rubric.criteria);
    verdict = determineVerdict(scores);
    summary = result.result.slice(0, 500);
  }
```

After:
```ts
  } else {
    // HIGH-02 — verdict precedence rule (#2): no LLM verdict to honor.
    // Synthesize defaults for every criterion, then derive verdict/overallScore
    // algorithmically. This branch only runs when neither the SDK's
    // `structuredOutput` nor a JSON parse of `result.result` matches
    // `GraderOutputSchema`.
    console.warn("[grader] Failed to parse structured output, using fallback scoring");
    scores = rubric.criteria.map(c => ({
      criterionName: c.name,
      score: 0.5,
      passed: false,
      feedback: "Could not evaluate — grader output was not structured",
    }));
    overallScore = computeWeightedScore(scores, rubric.criteria);
    verdict = determineVerdict(scores);
    summary = result.result.slice(0, 500);
  }
```

**Edit 4 — Add an inline comment at the fail-open branch (currently around line 153):**

Before:
```ts
    console.warn(`[grader] ${summary}. Skipping rubric gate.`);
    const satisfiedScores = rubric.criteria.map((criterion) => ({
      criterionName: criterion.name,
      score: 1,
      passed: true,
      feedback: "Rubric gate skipped because grader query failed",
    }));
    return {
      rubricResult: {
        rubricName: rubric.name,
        scores: satisfiedScores,
        verdict: "satisfied",
        overallScore: 1,
        summary,
        iteration: 0,
      },
      costUsd: 0,
    };
```

After:
```ts
    console.warn(`[grader] ${summary}. Skipping rubric gate.`);
    // HIGH-02 — verdict precedence rule (#3): grader outage → fail-open
    // verdict='satisfied' with overallScore=1 so infrastructure errors
    // (timeout, network, abort) do NOT block the orchestrator.
    const satisfiedScores = rubric.criteria.map((criterion) => ({
      criterionName: criterion.name,
      score: 1,
      passed: true,
      feedback: "Rubric gate skipped because grader query failed",
    }));
    return {
      rubricResult: {
        rubricName: rubric.name,
        scores: satisfiedScores,
        verdict: "satisfied",
        overallScore: 1,
        summary,
        iteration: 0,
      },
      costUsd: 0,
    };
```

**Self-check:**
- `grep -c "HIGH-02" src/evaluation/grader.ts` returns ≥ 4 (the JSDoc + 3 inline comments).
- `grep -c "verdict precedence" src/evaluation/grader.ts` returns ≥ 4.
- The actual ASSIGNMENTS to `verdict`, `scores`, `overallScore`, `summary` in the parsed-success branch are byte-for-byte unchanged (only comments added above).
  </action>
  <verify>
    <automated>npm run typecheck && grep -c "HIGH-02" src/evaluation/grader.ts | awk '$1 >= 4 { exit 0 } { exit 1 }' && grep -c "verdict precedence" src/evaluation/grader.ts | awk '$1 >= 4 { exit 0 } { exit 1 }'</automated>
  </verify>
  <done>
- The JSDoc block documents the three-tier precedence rule.
- Each precedence tier has an inline `HIGH-02 — verdict precedence rule (#N)` comment.
- No assignments inside the parsed-success branch are changed.
- `npm run typecheck` exits 0.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Add tests asserting LLM verdict precedence in both contradiction directions</name>
  <files>tests/evaluation/grader.test.ts</files>
  <behavior>
    - Test 1 (`'preserves LLM-emitted satisfied verdict even when scores would algorithmically grade as failed'`): grader returns structured output where `verdict: "satisfied"`, `overallScore: 0.85`, but the `scores` array has 3 of 3 criteria at score 0.1 / passed: false (which `determineVerdict()` would compute as "failed"). The function under test MUST return `verdict: "satisfied"` and `overallScore: 0.85` verbatim — NOT "failed", NOT 0.1.
    - Test 2 (`'preserves LLM-emitted failed verdict even when scores would algorithmically grade as satisfied'`): grader returns structured output where `verdict: "failed"`, `overallScore: 0.2`, but the `scores` array has all criteria at score 0.95 / passed: true (which `determineVerdict()` would compute as "satisfied"). The function under test MUST return `verdict: "failed"` and `overallScore: 0.2` verbatim.
  </behavior>
  <action>
Append the two tests to the existing `describe("gradePhaseOutput", ...)` block in `tests/evaluation/grader.test.ts`. Reuse the existing helper (whatever it's called in that file — likely a stream-mocking helper similar to `makeGraderStream` in `tests/integration/rubric-feedback.test.ts`). Inspect the file before editing to confirm the helper name and re-use it; if no helper exists, copy-adapt the local mock pattern already used in the file's other tests.

**Test 1 — LLM 'satisfied' wins over algorithmic 'failed':**

```ts
it("preserves LLM-emitted satisfied verdict even when scores would algorithmically grade as failed (HIGH-02)", async () => {
  // The LLM emits verdict='satisfied' with overallScore=0.85, but the per-criterion
  // scores it returns would, if fed into determineVerdict(), produce 'failed'
  // (3 of 3 criteria below threshold).
  // The grader MUST honor the LLM verdict verbatim — that's the verdict-precedence
  // contract per REQUIREMENTS.md HIGH-02.
  const llmOutput = {
    scores: [
      { criterionName: "compiles_cleanly", score: 0.1, passed: false, feedback: "build broken" },
      { criterionName: "tests_exist_and_pass", score: 0.05, passed: false, feedback: "no tests" },
      { criterionName: "no_security_issues", score: 0.0, passed: false, feedback: "leaked secrets" },
    ],
    verdict: "satisfied" as const,
    overallScore: 0.85,
    summary: "LLM optimistic despite low criterion scores",
  };

  // Use the file's existing stream-mocking helper. (Adjust the helper name if
  // the file already exports one; otherwise inline the mock per the existing
  // test-file pattern.)
  mockedQuery.mockReturnValue(makeGraderStream(llmOutput));

  const rubric = getPhaseRubric("development")!;
  const phaseResult: PhaseResult = { success: true, state: baseState, costUsd: 0.001 };
  const { rubricResult } = await gradePhaseOutput(rubric, phaseResult, baseState, {
    config: makeConfig(),
  });

  // Verdict and overallScore are returned VERBATIM from the LLM — not recomputed.
  expect(rubricResult.verdict).toBe("satisfied");
  expect(rubricResult.overallScore).toBeCloseTo(0.85, 5);
  // Scores are also unchanged.
  expect(rubricResult.scores).toEqual(llmOutput.scores);
  // Sanity check: determineVerdict(scores) on the same array would NOT have produced "satisfied".
  // (We don't import determineVerdict here — the assertion above already proves the precedence.)
});
```

**Test 2 — LLM 'failed' wins over algorithmic 'satisfied':**

```ts
it("preserves LLM-emitted failed verdict even when scores would algorithmically grade as satisfied (HIGH-02)", async () => {
  // Inverse direction: LLM says 'failed' with overallScore=0.2, but every score
  // is high enough that determineVerdict() would compute 'satisfied'. The LLM
  // verdict still wins.
  const llmOutput = {
    scores: [
      { criterionName: "compiles_cleanly", score: 0.95, passed: true, feedback: "all green" },
      { criterionName: "tests_exist_and_pass", score: 0.92, passed: true, feedback: "100% pass rate" },
      { criterionName: "no_security_issues", score: 0.98, passed: true, feedback: "clean SAST" },
    ],
    verdict: "failed" as const,
    overallScore: 0.2,
    summary: "LLM detected a fundamental architectural flaw not captured by the per-criterion scores",
  };

  mockedQuery.mockReturnValue(makeGraderStream(llmOutput));

  const rubric = getPhaseRubric("development")!;
  const phaseResult: PhaseResult = { success: true, state: baseState, costUsd: 0.001 };
  const { rubricResult } = await gradePhaseOutput(rubric, phaseResult, baseState, {
    config: makeConfig(),
  });

  // LLM verdict and overallScore preserved verbatim — even though scores would
  // algorithmically grade as 'satisfied'.
  expect(rubricResult.verdict).toBe("failed");
  expect(rubricResult.overallScore).toBeCloseTo(0.2, 5);
  expect(rubricResult.scores).toEqual(llmOutput.scores);
});
```

**Pre-edit check**: open `tests/evaluation/grader.test.ts` first to find the existing helpers (the file already has tests at lines 71, 105, 131, 164, 193, 221 — there must be a fixture/mock-stream helper and a `makeConfig`/`baseState` setup). Use those identifiers VERBATIM. If the helper is named differently (e.g. `makeStream` instead of `makeGraderStream`), use the actual name. Do NOT introduce a duplicate helper.

**Imports**: the file already imports from `../../src/evaluation/grader.js`, `../../src/evaluation/phase-rubrics.js`, `../../src/state/project-state.js`. Re-use; do NOT add new imports for the existing modules.

**Self-check:**
- The two `it(...)` blocks are added INSIDE the existing `describe("gradePhaseOutput", ...)`.
- `grep -c "HIGH-02" tests/evaluation/grader.test.ts` returns ≥ 2.
- `grep -c "preserves LLM-emitted" tests/evaluation/grader.test.ts` returns 2.
  </action>
  <verify>
    <automated>npm test -- --run tests/evaluation/grader.test.ts</automated>
  </verify>
  <done>
- Two new tests exist in `tests/evaluation/grader.test.ts` exercising both contradiction directions.
- Both pass against the unchanged grader code (the parsed-success path already preserves the LLM verdict verbatim).
- The full `tests/evaluation/grader.test.ts` file passes.
  </done>
</task>

<task type="auto">
  <name>Task 3: Full test sweep + lint to confirm baseline preserved</name>
  <files>(no files modified — verification-only)</files>
  <action>
1. `npm run typecheck`.
2. `npm test` — full suite. Must report ≥ 813/813 passing (was 811/811; new tests are +2). If any pre-existing test broke, the only behavioral change in this plan is documentation comments — investigate immediately.
3. `npm run lint`.
4. Record `grep -c "HIGH-02" src/evaluation/grader.ts tests/evaluation/grader.test.ts` for SUMMARY traceability.
  </action>
  <verify>
    <automated>npm run typecheck && npm test && npm run lint</automated>
  </verify>
  <done>
- `npm run typecheck` exits 0.
- `npm test` exits 0 with ≥ 813/813 passing.
- `npm run lint` exits 0.
- SUMMARY records the `HIGH-02` grep counts and re-asserts that no production logic changed (only JSDoc + inline comments added).
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| LLM grader output → grader.ts | Untrusted; validated by Zod (`GraderOutputSchema.safeParse`) |
| Parsed verdict → orchestrator | Internal; verdict enum is one of three values |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-03-02-01 | Tampering | Future refactor silently inverts precedence (algorithmic verdict overrides LLM) | mitigate | Two regression tests assert the LLM verdict survives even when contradicting `determineVerdict(scores)`. Refactor that breaks the rule fails CI. |
| T-03-02-02 | Tampering | LLM emits malformed JSON to bypass verdict precedence | accept | Falls through to algorithmic fallback (precedence rule #2); the documented behavior. |
| T-03-02-03 | Information Disclosure | Summary text from grader logged | accept | Already truncated to 500 chars in fallback path; LLM-source already wrapped via `wrapUserInput` upstream in grader prompt builder. |
</threat_model>

<verification>
End-to-end checks for this plan:
- `grep -c "HIGH-02" src/evaluation/grader.ts` ≥ 4 (JSDoc + 3 inline)
- `grep -c "verdict precedence" src/evaluation/grader.ts` ≥ 4
- `grep -c "HIGH-02" tests/evaluation/grader.test.ts` ≥ 2 (one per new test)
- The four assignment lines inside the parsed-success branch (`scores = parsed.data.scores;` …) are byte-for-byte unchanged.
- `npm run typecheck && npm test && npm run lint` all green.
</verification>

<success_criteria>
- HIGH-02 acceptance criterion #2 holds: the grader never replaces an LLM-emitted structured verdict — the rule is documented in JSDoc, inline at the precedence boundaries, and asserted by two tests covering both contradiction directions.
- Existing grader tests (lines 71, 105, 131, 164, 193, 221) continue to pass — no behavioral change to production code paths.
- 811/811 → 813/813 (or higher).
</success_criteria>

<output>
After completion, create `.planning/phases/03-high-priority-runtime-fixes/03-02-SUMMARY.md` with:
- The exact JSDoc block + 3 inline comments added to `src/evaluation/grader.ts`.
- The two test names and their assertions.
- Confirmation that no production-code assignments were changed (only documentation).
- Final test count.
</output>
