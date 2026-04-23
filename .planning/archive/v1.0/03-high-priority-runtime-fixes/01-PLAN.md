---
phase: 03-high-priority-runtime-fixes
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/orchestrator.ts
  - src/evaluation/evaluate-loop.ts
  - tests/integration/orchestrator.test.ts
autonomous: true
requirements:
  - HIGH-01
must_haves:
  truths:
    - "When the rubric verdict is 'needs_revision' and rubric retry budget remains, the phase handler is re-invoked with the gap-feedback string injected as PhaseContext.rubricFeedback"
    - "When the rubric verdict is 'failed', the orchestrator records a verification_failed failure on a dedicated rubric session in RunLedger before returning the failed PhaseResult"
    - "The retry budget is bounded by config.rubrics.maxIterations (default 3); the loop never exceeds that many handler invocations"
    - "evaluateWithRubric() in evaluate-loop.ts also escalates 'failed' verdicts to ledger when an active ledger is set via setActiveLedger (parity with the in-orchestrator loop)"
    - "npm run typecheck exits 0"
    - "npm test exits 0 (preserves 811/811 baseline; new tests count is +N where N is the new rubric-feedback-loop assertions)"
    - "npm run lint exits 0"
  artifacts:
    - path: "src/orchestrator.ts"
      provides: "Orchestrator rubric loop emits ledger.recordFailure('verification_failed', ...) on 'failed' verdict before returning the PhaseResult"
      contains: "verification_failed"
    - path: "src/evaluation/evaluate-loop.ts"
      provides: "Standalone evaluateWithRubric() escalates 'failed' verdicts via getActiveLedger()?.recordFailure(...)"
      contains: "verification_failed"
    - path: "tests/integration/orchestrator.test.ts"
      provides: "Test asserting that a 'failed' rubric verdict produces a ledger entry tagged verification_failed; test asserting that a 'needs_revision' verdict re-runs the handler with feedback"
      contains: "verification_failed"
  key_links:
    - from: "src/orchestrator.ts (rubric loop, ~lines 740-849)"
      to: "src/state/run-ledger.ts (RunLedger.startSession + recordFailure)"
      via: "setActiveLedger / module-level ledger reference already wired in runOrchestrator"
      pattern: "ledger\\.recordFailure\\(.*verification_failed"
    - from: "src/evaluation/evaluate-loop.ts"
      to: "src/state/run-ledger.ts (getActiveLedger)"
      via: "best-effort ledger lookup; no-op if no active ledger"
      pattern: "getActiveLedger"
---

<objective>
HIGH-01: Wire the rubric feedback loop end-to-end in the orchestrator so a `needs_revision` verdict re-invokes the phase handler with the gap-feedback inlined as `PhaseContext.rubricFeedback` (already present), AND a `failed` verdict escalates to `RunLedger` with the canonical reason code `verification_failed` before returning the failed `PhaseResult` (currently NOT wired). Apply the same `failed → ledger` escalation in the standalone `evaluateWithRubric()` helper for parity.

Purpose: Today, when the rubric grader returns `verdict: "failed"`, `executePhaseSafe()` in `src/orchestrator.ts` (lines ~826-828) returns the iteration's PhaseResult with the rubric attached, but does NOT record the failure in the run ledger. Per REQUIREMENTS.md HIGH-01 success criterion #1: "a `failed` verdict escalates to RunLedger with `verification_failed`." Without that escalation, post-run forensics (run-ledger.json) cannot answer "which phases were rejected by the rubric?", and SpendGovernor's `verification_failed` retry policy (`tests/governance/spend-governor.test.ts:108-117`) can never trigger because no caller ever emits the reason code.

Output: Two surgical edits — one in `src/orchestrator.ts`, one in `src/evaluation/evaluate-loop.ts` — plus two integration tests in `tests/integration/orchestrator.test.ts` that exercise the loop with a mocked grader and assert (a) handler is re-invoked on `needs_revision` with feedback, (b) ledger contains a `verification_failed` entry on `failed`.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/REQUIREMENTS.md
@.planning/phases/03-high-priority-runtime-fixes/03-CONTEXT.md
@.claude/skills/typescript/SKILL.md
@src/orchestrator.ts
@src/evaluation/evaluate-loop.ts
@src/evaluation/grader.ts
@src/state/run-ledger.ts
@tests/integration/orchestrator.test.ts
@tests/integration/rubric-feedback.test.ts

<interfaces>
<!-- Key contracts the executor needs. Extracted from codebase. Use these directly. -->

From src/state/run-ledger.ts (existing API — do NOT redefine):
```typescript
import { setActiveLedger, getActiveLedger } from "../state/run-ledger.js";

class RunLedger {
  startSession(attribution: SessionAttribution): SessionRecord;
  recordFailure(sessionId: string, reasonCode: ReasonCode, message: string): SessionRecord | null;
  endSession(sessionId: string, outcome: { success: boolean }): void;
}

// SessionAttribution required fields used here:
// { phase, role, sessionType, model? }
// sessionType is one of: "coordinator" | "team_lead" | "child_agent" | "subagent" | "rubric" | "memory" | "retry"
// → use "rubric" for rubric verdicts.

// Canonical reason codes (src/types/failure-codes.ts):
//   "provider_limit" | "provider_rate_limit" | "invalid_structured_output" |
//   "verification_failed" | "blocked_filesystem" | "unsupported_team_runtime" |
//   "transient" | "timeout" | "unknown"
```

From src/evaluation/rubric.ts:
```typescript
export interface RubricResult {
  rubricName: string;
  scores: CriterionScore[];
  verdict: "satisfied" | "needs_revision" | "failed";
  overallScore: number;
  summary: string;
  iteration: number;
}
```

From src/orchestrator.ts (current rubric loop, lines ~826-828):
```typescript
// CURRENT — returns failed verdict without escalation:
if (rubricResult.verdict === "satisfied" || rubricResult.verdict === "failed") {
  return { ...iterResult, costUsd: rubricCost, rubricResult };
}
```

The `ledger` variable is in scope inside `runOrchestrator()` (line 263:
`const ledger = new RunLedger(runId);`). `executePhaseSafe()` does NOT receive
it as a parameter. Two viable implementations — pick the simpler:
  (A) Use `getActiveLedger()` from run-ledger.js (already exported; honors
      `setActiveLedger(ledger)` called on line 264).
  (B) Plumb `ledger` through `executePhaseSafe()` as a new parameter.

**Decision: use (A)**. `setActiveLedger(ledger)` is already called at runOrchestrator startup (line 264). `getActiveLedger()` returns the current ledger or `null`. Best-effort escalation — if no ledger is active (e.g. unit tests), skip silently. This matches the pattern used elsewhere in run-ledger consumers and avoids changing the executePhaseSafe signature (which would force every test to pass a fake ledger).

From src/evaluation/evaluate-loop.ts (current "failed" return path, lines ~92-107):
```typescript
if (rubricResult.verdict === "satisfied" || rubricResult.verdict === "failed") {
  // ... emits evaluation.rubric.end event; does NOT touch ledger.
  return { ...phaseResult, costUsd: totalCost, rubricResult, totalIterations: iteration };
}
```

From tests/integration/rubric-feedback.test.ts (existing pattern to MIRROR for new tests):
- Uses `vi.mock("@anthropic-ai/claude-agent-sdk", ...)`.
- Helper `makeGraderStream({ scores, verdict, overallScore, summary })` already
  built — reuse this pattern via copy-adapt or extract to a helpers file inside
  the test module.
- Existing test `"stops immediately when grader returns failed verdict"` (line
  161) asserts the verdict; it does NOT assert ledger interaction. The new
  orchestrator-level test must do BOTH.
</interfaces>

<notes_for_executor>
1. **Single concern per file**: orchestrator gets the in-loop escalation; evaluate-loop gets the parity escalation; tests assert both. Do not refactor either file beyond the additions described.
2. **Reason code is exactly `"verification_failed"`** — the canonical code from `src/types/failure-codes.ts`. Do not invent a new code.
3. **Session type for rubric escalation is `"rubric"`** — it's already in `SessionTypeSchema` (`src/state/run-ledger.ts:14-22`). Do not reuse `"coordinator"`.
4. **Best-effort pattern**: wrap `getActiveLedger()?.startSession(...)` in try/catch; a ledger error must NEVER mask the actual phase failure being reported.
5. **The needs_revision retry path is ALREADY wired** in orchestrator.ts (lines ~830-839 build `rubricFeedback` and inject into `ctx`). This plan MUST NOT re-wire it; it MUST add a regression test that proves it still works after our edits (handler called twice, second call's `execCtx.context.rubricFeedback` is defined).
6. **The grader can return verdict='failed' via two paths**: (a) the LLM emits it directly; (b) `determineVerdict(scores)` computes it from scores when more than half fail. Both paths land at the same `verdict === "failed"` branch — our escalation must fire in both.
7. **Keep the existing console.log** at line ~822 for verdict/score; just append a `console.log("[ledger] verification_failed recorded for phase ${phase}")` after the new recordFailure call so operators can see the escalation.
8. **TypeScript strict mode** — `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, ESM `.js` imports — see `.claude/skills/typescript/SKILL.md`.
</notes_for_executor>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Add ledger escalation to orchestrator rubric loop on 'failed' verdict</name>
  <files>src/orchestrator.ts</files>
  <behavior>
    - When the rubric loop in `executePhaseSafe()` lands on `rubricResult.verdict === "failed"`, the orchestrator MUST call `getActiveLedger()?.startSession({ phase, role: "rubric-grader", sessionType: "rubric", model: config.rubrics?.graderModel ?? config.subagentModel })`, then `recordFailure(session.sessionId, "verification_failed", rubricResult.summary || \`rubric ${rubric.name} failed with score ${rubricResult.overallScore}\`)`, then `endSession(session.sessionId, { success: false })`.
    - The escalation MUST be best-effort — wrapped in try/catch, errors logged via `errMsg(err)` and a console.warn, never re-thrown.
    - The escalation MUST happen BEFORE the `return { ...iterResult, costUsd: rubricCost, rubricResult }` for the `failed` branch.
    - The `satisfied` branch MUST NOT call recordFailure.
    - The `needs_revision` retry path MUST be unchanged — the existing rubricFeedback injection at lines ~830-839 must still run.
  </behavior>
  <action>
**Edit 1 — Add `getActiveLedger` to the run-ledger import (line 42):**

Before:
```ts
import { RunLedger, setActiveLedger } from "./state/run-ledger.js";
```

After:
```ts
import { RunLedger, setActiveLedger, getActiveLedger } from "./state/run-ledger.js";
```

**Edit 2 — Replace the `satisfied || failed` branch inside the rubric loop (currently around lines 826-828) with split branches:**

Before (the `for (let iter = 1; iter <= maxIter; iter++)` block in `executePhaseSafe`):
```ts
if (rubricResult.verdict === "satisfied" || rubricResult.verdict === "failed") {
  return { ...iterResult, costUsd: rubricCost, rubricResult };
}
```

After:
```ts
if (rubricResult.verdict === "satisfied") {
  return { ...iterResult, costUsd: rubricCost, rubricResult };
}
if (rubricResult.verdict === "failed") {
  // HIGH-01: escalate failed rubric verdict to RunLedger with the canonical
  // `verification_failed` reason code. Best-effort — a ledger error must not
  // mask the actual phase outcome being returned to the caller.
  try {
    const activeLedger = getActiveLedger();
    if (activeLedger) {
      const graderModel =
        config.rubrics?.graderModel ?? config.subagentModel;
      const session = activeLedger.startSession({
        phase,
        role: "rubric-grader",
        sessionType: "rubric",
        model: graderModel,
      });
      const failureMessage =
        rubricResult.summary?.trim().length
          ? rubricResult.summary
          : `Rubric "${rubric.name}" failed at iteration ${iter} with overall score ${rubricResult.overallScore.toFixed(2)}`;
      activeLedger.recordFailure(
        session.sessionId,
        "verification_failed",
        failureMessage,
      );
      activeLedger.endSession(session.sessionId, { success: false });
      console.log(
        `[ledger] verification_failed recorded for phase "${phase}" (rubric "${rubric.name}", score ${rubricResult.overallScore.toFixed(2)})`,
      );
    }
  } catch (err) {
    console.warn(
      `[ledger] Failed to record verification_failed escalation for phase "${phase}": ${errMsg(err)}`,
    );
  }
  return { ...iterResult, costUsd: rubricCost, rubricResult };
}
```

**Self-check:**
- `grep -nE 'verification_failed' src/orchestrator.ts` returns at least 2 matches (the recordFailure call + the console.log line).
- The `needs_revision` block immediately below (lines ~830-839 in the current file) is untouched; `if (iter < maxIter) { rubricFeedback = "## Rubric Feedback ..."` still runs.
  </action>
  <verify>
    <automated>npm run typecheck && grep -cE 'recordFailure\(.*verification_failed' src/orchestrator.ts | awk '$1 >= 1 { exit 0 } { exit 1 }' && grep -cE 'rubricResult\.verdict === "needs_revision"|rubricFeedback =' src/orchestrator.ts | awk '$1 >= 1 { exit 0 } { exit 1 }'</automated>
  </verify>
  <done>
- `src/orchestrator.ts` imports `getActiveLedger`.
- The `satisfied || failed` combined branch is split into two; the `failed` branch invokes `activeLedger.recordFailure(..., "verification_failed", ...)` inside a try/catch.
- The `needs_revision` retry path is unchanged.
- `npm run typecheck` exits 0.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Add the same ledger escalation to evaluateWithRubric() in evaluate-loop.ts</name>
  <files>src/evaluation/evaluate-loop.ts</files>
  <behavior>
    - When `evaluateWithRubric()` returns inside the `verdict === "failed"` branch (lines ~92-107), the function MUST first call `getActiveLedger()?.recordFailure(...)` exactly as in Task 1, scoped to a freshly-started rubric session.
    - When the phase handler itself fails (`!phaseResult.success`, lines ~46-67) producing the synthetic `verdict: "failed"` result, the function MUST also call the same ledger escalation. (Both code paths land in a "failed" terminal — both must escalate.)
    - When the verdict is `satisfied` or `needs_revision` (latter inside the loop), no ledger call is made.
  </behavior>
  <action>
**Edit 1 — Add ledger import to `src/evaluation/evaluate-loop.ts` (after the existing imports at top):**

Before (the import block at lines 1-6):
```ts
import type { Config } from "../utils/config.js";
import type { PhaseResult } from "../phases/types.js";
import type { Phase } from "../state/project-state.js";
import type { Rubric, RubricResult, EvaluatedPhaseResult } from "./rubric.js";
import type { EventBus } from "../events/event-bus.js";
import { gradePhaseOutput } from "./grader.js";
```

After:
```ts
import type { Config } from "../utils/config.js";
import type { PhaseResult } from "../phases/types.js";
import type { Phase } from "../state/project-state.js";
import type { Rubric, RubricResult, EvaluatedPhaseResult } from "./rubric.js";
import type { EventBus } from "../events/event-bus.js";
import { gradePhaseOutput } from "./grader.js";
import { getActiveLedger } from "../state/run-ledger.js";
import { errMsg } from "../utils/shared.js";
```

**Edit 2 — Add a private helper `escalateRubricFailureToLedger` near the top of the file (after the imports, before `export async function evaluateWithRubric`):**

```ts
/**
 * HIGH-01: Best-effort escalation of a `failed` rubric verdict into the active
 * RunLedger with reason code `verification_failed`. No-op if no ledger is set
 * (e.g. unit tests that don't bootstrap an orchestrator). Errors are swallowed
 * — a ledger failure must never mask the actual phase outcome being reported.
 */
function escalateRubricFailureToLedger(
  phase: Phase | undefined,
  rubric: Rubric,
  rubricResult: RubricResult,
  config: Config,
): void {
  if (!phase) return;
  try {
    const ledger = getActiveLedger();
    if (!ledger) return;
    const graderModel = config.rubrics?.graderModel ?? config.subagentModel;
    const session = ledger.startSession({
      phase,
      role: "rubric-grader",
      sessionType: "rubric",
      model: graderModel,
    });
    const message = rubricResult.summary?.trim().length
      ? rubricResult.summary
      : `Rubric "${rubric.name}" failed at iteration ${rubricResult.iteration} with overall score ${rubricResult.overallScore.toFixed(2)}`;
    ledger.recordFailure(session.sessionId, "verification_failed", message);
    ledger.endSession(session.sessionId, { success: false });
    console.log(
      `[ledger] verification_failed recorded for phase "${phase}" (rubric "${rubric.name}")`,
    );
  } catch (err) {
    console.warn(
      `[ledger] Failed to record verification_failed escalation: ${errMsg(err)}`,
    );
  }
}
```

**Edit 3 — Wire the helper into the two terminal `failed` paths in `evaluateWithRubric`:**

(a) Inside the `if (!phaseResult.success)` block (currently around lines 46-67), after constructing the synthetic `failed` `RubricResult` and BEFORE the `return` statement, add:
```ts
escalateRubricFailureToLedger(phase, rubric, {
  rubricName: rubric.name,
  scores: [],
  verdict: "failed",
  overallScore: 0,
  summary: `Phase handler failed: ${phaseResult.error ?? "unknown error"}`,
  iteration,
}, config);
```
(Place this right before the `return { ...phaseResult, costUsd: totalCost, rubricResult: {...}, totalIterations: iteration };` statement; the literal RubricResult shape passed to the helper must match the one in the return.)

(b) Inside the `if (rubricResult.verdict === "satisfied" || rubricResult.verdict === "failed")` block (currently around lines 92-107), split it the same way as in orchestrator.ts:

Before:
```ts
if (rubricResult.verdict === "satisfied" || rubricResult.verdict === "failed") {
  if (phase !== undefined) {
    eventBus?.emit("evaluation.rubric.end", {
      phase, rubricName: rubric.name, result: rubricResult.verdict, iteration,
    });
  }
  return { ...phaseResult, costUsd: totalCost, rubricResult, totalIterations: iteration };
}
```

After:
```ts
if (rubricResult.verdict === "satisfied" || rubricResult.verdict === "failed") {
  if (phase !== undefined) {
    eventBus?.emit("evaluation.rubric.end", {
      phase, rubricName: rubric.name, result: rubricResult.verdict, iteration,
    });
  }
  if (rubricResult.verdict === "failed") {
    escalateRubricFailureToLedger(phase, rubric, rubricResult, config);
  }
  return { ...phaseResult, costUsd: totalCost, rubricResult, totalIterations: iteration };
}
```

**Self-check:**
- `grep -c 'escalateRubricFailureToLedger' src/evaluation/evaluate-loop.ts` returns ≥ 3 (1 definition + 2 call sites).
- `grep -c 'verification_failed' src/evaluation/evaluate-loop.ts` returns ≥ 1.
- The `needs_revision` block (around lines 109-120) is untouched.
  </action>
  <verify>
    <automated>npm run typecheck && grep -c 'escalateRubricFailureToLedger' src/evaluation/evaluate-loop.ts | awk '$1 >= 3 { exit 0 } { exit 1 }' && grep -c 'verification_failed' src/evaluation/evaluate-loop.ts | awk '$1 >= 1 { exit 0 } { exit 1 }'</automated>
  </verify>
  <done>
- `src/evaluation/evaluate-loop.ts` imports `getActiveLedger` and `errMsg`.
- A new private function `escalateRubricFailureToLedger` exists.
- Both terminal `failed` paths inside `evaluateWithRubric` invoke the helper before returning.
- `npm run typecheck` exits 0.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Add integration tests for the rubric feedback loop end-to-end</name>
  <files>tests/integration/orchestrator.test.ts</files>
  <behavior>
    - Test 1 (`'rubric verdict failed escalates to ledger as verification_failed'`): Mocks the grader (via `gradePhaseOutput`) to return verdict=`failed`. Bootstraps an orchestrator run for the `architecture` phase (which has a configured rubric). After the run, asserts that `RunLedger.persist()` wrote a session with `failures[0].reasonCode === "verification_failed"` and `sessionType === "rubric"`.
    - Test 2 (`'rubric verdict needs_revision re-runs handler with rubricFeedback injected'`): Mocks the grader to return `needs_revision` on first call and `satisfied` on second. Uses `mockedRunArchitecture.mockImplementation` (the existing pattern at line 346) to capture every `execCtx.context` passed in. Asserts the architecture handler is called at least 2 times AND the second call's `execCtx.context.rubricFeedback` is a defined string containing `"## Rubric Feedback"`.
  </behavior>
  <action>
Append the two tests to the existing `describe("Orchestrator", ...)` block at the end of `tests/integration/orchestrator.test.ts` (after the existing `it("rubric loop passes the same PhaseContext object across retries (built once, reused)", ...)` test).

The existing file already mocks the SDK and the grader (`mockedGradePhaseOutput`) and uses `runOrchestrator(state, config, undefined, "architecture")` for single-phase runs — match that pattern.

**Test 1 — failed verdict escalation:**

```ts
it("rubric verdict 'failed' escalates to ledger as verification_failed (HIGH-01)", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");

  const state = createInitialState("test rubric ledger escalation");
  const specState: ProjectState = {
    ...state,
    spec: {
      summary: "S",
      userStories: [],
      nonFunctionalRequirements: [],
      domain: {
        classification: "general",
        specializations: [],
        requiredRoles: [],
        requiredMcpServers: [],
        techStack: [],
      },
    },
  };

  mockedRunArchitecture.mockImplementation(async () => ({
    success: true,
    state: specState,
    costUsd: 0.01,
  }));

  // Force the grader to return a failed verdict on the very first iteration.
  mockedGradePhaseOutput.mockResolvedValueOnce({
    rubricResult: {
      rubricName: "Architecture Quality",
      scores: [
        { criterionName: "scalability_addressed", score: 0.1, passed: false, feedback: "no scaling story" },
        { criterionName: "separation_of_concerns", score: 0.2, passed: false, feedback: "spaghetti" },
        { criterionName: "tech_stack_justified", score: 0.1, passed: false, feedback: "no rationale" },
      ],
      verdict: "failed",
      overallScore: 0.13,
      summary: "Fundamentally wrong architecture",
      iteration: 1,
    },
    costUsd: 0.001,
  });

  const config: Config = {
    ...makeConfig(),
    rubrics: { enabled: true, maxIterations: 3 },
  };

  await runOrchestrator(state, config, undefined, "architecture");

  // Locate the persisted ledger file.
  const ledgerDir = join(config.stateDir, "ledger");
  expect(existsSync(ledgerDir)).toBe(true);
  const { readdirSync } = await import("node:fs");
  const files = readdirSync(ledgerDir).filter((f) => f.endsWith(".json"));
  expect(files.length).toBeGreaterThan(0);
  const ledgerPath = join(ledgerDir, files[0]!);
  const ledgerSnapshot = JSON.parse(readFileSync(ledgerPath, "utf-8"));

  const rubricSessions = (ledgerSnapshot.sessions ?? []).filter(
    (s: { sessionType: string }) => s.sessionType === "rubric",
  );
  expect(rubricSessions.length).toBeGreaterThanOrEqual(1);
  const rubricFailures = rubricSessions.flatMap(
    (s: { failures: Array<{ reasonCode: string }> }) => s.failures,
  );
  expect(
    rubricFailures.some((f) => f.reasonCode === "verification_failed"),
  ).toBe(true);
});
```

**Test 2 — needs_revision re-invokes handler with feedback:**

```ts
it("rubric verdict 'needs_revision' re-runs handler with rubricFeedback injected (HIGH-01)", async () => {
  const state = createInitialState("test rubric needs revision");
  const specState: ProjectState = {
    ...state,
    spec: {
      summary: "S",
      userStories: [],
      nonFunctionalRequirements: [],
      domain: {
        classification: "general",
        specializations: [],
        requiredRoles: [],
        requiredMcpServers: [],
        techStack: [],
      },
    },
  };

  const capturedCtxs: Array<
    { rubricFeedback?: string | undefined; cachedSystemPrompt?: string | undefined } | undefined
  > = [];
  mockedRunArchitecture.mockImplementation(async (_s, _c, execCtx) => {
    capturedCtxs.push(execCtx?.context);
    return { success: true, state: specState, costUsd: 0.01 };
  });

  mockedGradePhaseOutput
    .mockResolvedValueOnce({
      rubricResult: {
        rubricName: "Architecture Quality",
        scores: [
          { criterionName: "scalability_addressed", score: 0.5, passed: false, feedback: "no autoscale plan" },
          { criterionName: "separation_of_concerns", score: 0.9, passed: true, feedback: "ok" },
        ],
        verdict: "needs_revision",
        overallScore: 0.7,
        summary: "needs scaling",
        iteration: 1,
      },
      costUsd: 0.001,
    })
    .mockResolvedValueOnce({
      rubricResult: {
        rubricName: "Architecture Quality",
        scores: [
          { criterionName: "scalability_addressed", score: 0.85, passed: true, feedback: "fixed" },
          { criterionName: "separation_of_concerns", score: 0.9, passed: true, feedback: "ok" },
        ],
        verdict: "satisfied",
        overallScore: 0.875,
        summary: "good",
        iteration: 2,
      },
      costUsd: 0.001,
    });

  const config: Config = {
    ...makeConfig(),
    rubrics: { enabled: true, maxIterations: 3 },
  };

  await runOrchestrator(state, config, undefined, "architecture");

  expect(mockedRunArchitecture).toHaveBeenCalledTimes(2);
  expect(capturedCtxs.length).toBeGreaterThanOrEqual(2);

  // First call: no rubricFeedback yet (initial run)
  expect(capturedCtxs[0]?.rubricFeedback).toBeUndefined();
  // Second call: rubricFeedback contains the gap header from the needs_revision verdict
  expect(capturedCtxs[1]?.rubricFeedback).toBeDefined();
  expect(capturedCtxs[1]?.rubricFeedback).toContain("Rubric Feedback");
  expect(capturedCtxs[1]?.rubricFeedback).toContain("scalability_addressed");
});
```

**Helper imports**: the file already imports `createInitialState`, `runOrchestrator`, `Config`, `mockedRunArchitecture`, `mockedGradePhaseOutput`, etc. Do NOT re-import. Use `await import(...)` for `node:fs` / `node:path` to keep top-of-file imports unchanged.

**Self-check:**
- The two tests are appended INSIDE the existing `describe("Orchestrator", ...)` block (the closing `});` at the bottom of the file should still be the closer for that describe).
- `grep -c "verification_failed" tests/integration/orchestrator.test.ts` returns ≥ 1.
- `grep -c "rubricFeedback" tests/integration/orchestrator.test.ts` returns ≥ 4 (the existing test uses it twice; new test uses it twice).
  </action>
  <verify>
    <automated>npm test -- --run tests/integration/orchestrator.test.ts</automated>
  </verify>
  <done>
- Two new `it(...)` blocks exist in `tests/integration/orchestrator.test.ts`.
- Both pass against the edits from Tasks 1 and 2.
- The full target file passes (`npm test -- --run tests/integration/orchestrator.test.ts` exits 0).
  </done>
</task>

<task type="auto">
  <name>Task 4: Full test sweep + lint to confirm baseline preserved</name>
  <files>(no files modified — verification-only)</files>
  <action>
1. `npm run typecheck` — strict-mode types must still hold across orchestrator + evaluate-loop.
2. `npm test` — full suite. Must report ≥ 813/813 passing (was 811/811; new tests are +2). If any pre-existing test broke, investigate why — the rubric loop's behavior for the `satisfied` and `needs_revision` paths MUST be unchanged.
3. `npm run lint` — zero eslint errors in `src/`.
4. `grep -c verification_failed src/orchestrator.ts src/evaluation/evaluate-loop.ts tests/integration/orchestrator.test.ts` — record counts in SUMMARY for traceability.
  </action>
  <verify>
    <automated>npm run typecheck && npm test && npm run lint</automated>
  </verify>
  <done>
- `npm run typecheck` exits 0.
- `npm test` exits 0 with ≥ 813/813 passing.
- `npm run lint` exits 0.
- SUMMARY records the per-file `verification_failed` grep counts.
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Phase output → Rubric grader | LLM-graded; non-deterministic verdicts |
| Rubric verdict → RunLedger | Internal; verdict shape validated by Zod (`RubricResult`) |
| RunLedger snapshot → on-disk JSON | `assertSafePath` already enforced inside RunLedger.persist |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-03-01-01 | Repudiation | Failed phases not recorded in ledger forensics | mitigate | Escalate every `failed` rubric verdict via `recordFailure(..., "verification_failed", ...)`; reasonCode is from the closed `CanonicalFailureReasonCode` set so analytic tooling can filter cleanly. |
| T-03-01-02 | Tampering | Grader summary text injected into ledger | accept | Summary is LLM-authored and stored as a string; ledger entries are never executed. Length-bounded by ledger schema. |
| T-03-01-03 | Denial of Service | Ledger error masking actual phase outcome | mitigate | All ledger operations wrapped in try/catch; failure logs via `console.warn` with `errMsg(err)` and never re-throws. |
</threat_model>

<verification>
End-to-end checks for this plan:
- `grep -c 'verification_failed' src/orchestrator.ts` ≥ 1
- `grep -c 'verification_failed' src/evaluation/evaluate-loop.ts` ≥ 1
- `grep -c 'verification_failed' tests/integration/orchestrator.test.ts` ≥ 1
- The `needs_revision` retry path in orchestrator.ts (the `rubricFeedback = "## Rubric Feedback ..."` block at lines ~830-839) is byte-for-byte unchanged outside the split conditional.
- `npm run typecheck && npm test && npm run lint` all green.
</verification>

<success_criteria>
- HIGH-01 acceptance criterion #1 holds: a `needs_revision` verdict re-invokes the handler with the gap-feedback inlined; a `failed` verdict escalates to RunLedger with `verification_failed`.
- 811/811 → 813/813 (or higher) passing tests after the new assertions.
- The existing rubric-feedback tests in `tests/integration/rubric-feedback.test.ts` still pass — the standalone `evaluateWithRubric` helper's behavior is preserved (modulo the new ledger side-effect, which is best-effort and ledger-absent in those tests).
</success_criteria>

<output>
After completion, create `.planning/phases/03-high-priority-runtime-fixes/03-01-SUMMARY.md` with:
- The exact diff applied to `src/orchestrator.ts` (lines ~826-828 split + new failed-branch escalation block).
- The exact diff applied to `src/evaluation/evaluate-loop.ts` (helper + two call sites).
- The two new test names + counts of `verification_failed` per file.
- Confirmation that 811/811 (or higher) baseline holds and `npm run lint` is clean.
</output>
