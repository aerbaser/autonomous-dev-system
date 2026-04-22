---
phase: 03-high-priority-runtime-fixes
plan: 04
subsystem: testing
tags: [zod, vitest, specification, llm-schemas, regression-test, high-04]

# Dependency graph
requires:
  - phase: 02-critical-security-backlog-closure
    provides: pinned SDK 0.2.90 + ConfigSchema audit (so the test mock surface is stable)
provides:
  - Locked-in unit-test contract for runSpecification (4 regression tests)
  - JSDoc invariant header on src/phases/specification.ts naming the one-directional import boundary and the HIGH-04 closure
  - Documented circular-import audit outcome (NO CYCLES DETECTED)
affects: [architecture, development, integration tests, future refactors of specification.ts]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Phase-handler unit test pattern: vi.mock('@anthropic-ai/claude-agent-sdk') + makeStream async-iterator + makeConfig + makeStateWithSpec fixtures"
    - "Schema-violation test trigger: omit a required Zod field rather than relying on .min(N) constraints that the schema may not enforce"

key-files:
  created:
    - tests/phases/specification.test.ts
    - .planning/phases/03-high-priority-runtime-fixes/deferred-items.md
  modified:
    - src/phases/specification.ts (JSDoc header only — zero behavior change)

key-decisions:
  - "HIGH-04 closure is verification-and-lock-in, not a rewrite: specification.ts was already a real handler in current tree; the plan's value is the regression net (4 tests) + JSDoc invariant, not new behavior."
  - "Test 4 (schema-violation) triggers a structural violation (omit integrationBoundaries) rather than the plan's proposed count violation (.min(2) on outOfScope) — the actual DetailedSpecSchema in src/types/llm-schemas.ts has no .min(N) constraint, so the planned test would have passed instead of failed. Fixture corrected to use a real violation the schema actually rejects."
  - "Out-of-scope failing tests (interrupter timing test, optimizer mutation tests, missing blueprint-verifier module) logged in deferred-items.md per SCOPE BOUNDARY rule — none touch src/phases/specification.ts."

patterns-established:
  - "JSDoc HIGH-N closure header: top-of-file block naming the requirement-ID + the import contract that the test file pins. Future phase handlers closing a HIGH/SEC backlog item should follow this pattern so a grep for the requirement ID surfaces the lock-in artifact."
  - "Circular-import audit invocation: `npx tsc --noEmit --extendedDiagnostics 2>&1 | grep -iE 'circ|recur' || echo NO CYCLES DETECTED`. Cheap to run, deterministic, suitable for CI."

requirements-completed: [HIGH-04]

# Metrics
duration: 13 min
completed: 2026-04-22
---

# Phase 03 Plan 04: HIGH-04 — verify specification.ts is real + add regression tests Summary

**4 unit tests in tests/phases/specification.test.ts pin runSpecification's success / missing-input / bad-JSON / schema-violation paths, plus a JSDoc invariant header on src/phases/specification.ts that documents the one-directional import contract and HIGH-04 closure.**

## Performance

- **Duration:** ~13 min
- **Started:** 2026-04-22T18:25:00Z (approx)
- **Completed:** 2026-04-22T18:38:31Z
- **Tasks:** 3
- **Files modified:** 2 (1 source, 1 test); 1 supporting doc (deferred-items.md)

## Accomplishments

1. **Audited specification.ts** — confirmed all 7 imports match the planned contract and the file is a real handler (no stub branches, no `throw new Error(...stub...)`, no `// TODO: stub`).
2. **Circular-import audit** — `npx tsc --noEmit --extendedDiagnostics 2>&1 | grep -iE "circ|recur"` → **NO CYCLES DETECTED**. HIGH-04 acceptance criterion #4 ("`npm run typecheck` confirms") satisfied.
3. **JSDoc invariant header** — added a top-of-file block to `src/phases/specification.ts` naming the one-directional import boundary (`../state/project-state.js` types-only, `../types/llm-schemas.js` Zod schema, `../utils/sdk-helpers.js` / `../utils/shared.js` infra, `./types.js` return shape) and the HIGH-04 closure rationale. Zero behavior change.
4. **4 new tests** in `tests/phases/specification.test.ts` — pattern mirrors `tests/phases/ideation.test.ts` (`vi.mock("@anthropic-ai/claude-agent-sdk")` + `makeStream` async-iterator + `makeConfig` + `makeStateWithSpec` fixtures). All 4 pass on first run against the unchanged handler.

## JSDoc Block Added (verbatim)

```ts
/**
 * Phase: specification (#2 in the 12-phase lifecycle).
 *
 * Takes the coarse `state.spec` produced by ideation and expands it into
 * implementation-ready detail:
 *   - refined user stories with Given/When/Then acceptance criteria
 *   - non-functional requirements with concrete thresholds (no "fast" / "secure")
 *   - explicit out-of-scope list
 *   - integration boundaries with protocol + ownership + failure semantics
 *
 * The result is validated against `DetailedSpecSchema` (Zod) and written back
 * onto `state.spec.detailed`. Next phase: `architecture`.
 *
 * **HIGH-04 (REQUIREMENTS.md v1 milestone):** this file is a REAL handler, not
 * a stub. Imports are kept deliberately minimal and one-directional:
 *   - `../state/project-state.js` — types only
 *   - `../types/llm-schemas.js` — Zod schema + inferred type
 *   - `../utils/sdk-helpers.js` / `../utils/shared.js` — infrastructure helpers
 *   - `./types.js` — phase return shape
 * No import ever closes a cycle back into this file. `tests/phases/specification.test.ts`
 * locks that invariant in with unit coverage of the success, missing-input,
 * bad-JSON, and schema-violation paths.
 */
```

## Verbatim Import List (src/phases/specification.ts)

7 imports, all one-directional and matching the plan's contract:

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../utils/config.js";
import type { ProjectState, ProductSpec } from "../state/project-state.js";
import type { PhaseResult, PhaseExecutionContext } from "./types.js";
import { consumeQuery, getQueryPermissions, getMaxTurns } from "../utils/sdk-helpers.js";
import { extractFirstJson, errMsg, wrapUserInput } from "../utils/shared.js";
import { DetailedSpecSchema, type DetailedSpec } from "../types/llm-schemas.js";
```

## Circular-import Audit Outcome

```
$ npx tsc --noEmit --extendedDiagnostics 2>&1 | grep -iE "circ|recur" || echo "NO CYCLES DETECTED"
NO CYCLES DETECTED

$ grep -rn "from.*phases/specification" src/ tests/ --include="*.ts" 2>/dev/null
src/orchestrator.ts:25:import { runSpecification } from "./phases/specification.js";
```

Only one importer in `src/` (the orchestrator) and zero importers in `tests/` (other than the new test file post-Plan 03-04). No back-import path closes a cycle into specification.ts.

## 4 New Tests in tests/phases/specification.test.ts

| # | Test name | One-line description |
|---|-----------|----------------------|
| 1 | `returns success and populates state.spec.detailed with parsed DetailedSpec` | Mocked LLM returns valid `DetailedSpec` JSON → handler returns `{ success: true, nextPhase: "architecture" }` and `state.spec.detailed` equals payload byte-for-byte. |
| 2 | `returns failure when state.spec is missing` | Input state has `spec: null` → handler returns `{ success: false, error: "No spec found. Run ideation first." }` WITHOUT invoking the SDK (`mockedQuery` not called). |
| 3 | `returns failure when the LLM response contains no valid JSON` | Mocked LLM returns prose only → handler returns `{ success: false, error: "specification: no valid JSON in LLM output" }`. |
| 4 | `returns failure when the extracted JSON does not satisfy DetailedSpecSchema` | Mocked LLM returns JSON missing `integrationBoundaries` → Zod `.safeParse` rejects → handler returns `{ success: false, error: /specification: invalid DetailedSpec JSON/ }`. |

## Test Count Delta

- Baseline (HEAD before Plan 03-04): 811 passing tests in 80 test files (1 pre-existing FAIL in `blueprint-verifier.test.ts` — module-not-found, out of scope).
- After Plan 03-04: 815 passing tests in 81 test files (+4 from new specification suite, +1 file).
- Confirmed by isolated run: `npm test -- --run tests/phases/specification.test.ts` → 4 passed (4) deterministically.

## Lint / Typecheck Confirmation

- `npm run typecheck` → exits 0 (clean).
- `npm run lint` → exits 0 (clean).

## Task Commits

Each task committed atomically:

1. **Task 1: Audit specification.ts imports + circular-import check + JSDoc header** — `cfeb319` (`docs(03-04): add JSDoc contract + HIGH-04 invariant header to specification.ts`)
2. **Task 2: Add tests/phases/specification.test.ts covering 4 behaviors** — `9b0c675` (`test(03-04): add tests/phases/specification.test.ts — 4 regression tests for runSpecification`)
3. **Task 3: Full test sweep + lint** — verification-only, no code commit (results captured in this SUMMARY).

**Plan metadata commit:** added in the same step as this SUMMARY (see git log for hash post-commit).

## Files Created/Modified

- `src/phases/specification.ts` — added 23-line JSDoc header above the imports; zero functional change. Total file delta: +23 lines.
- `tests/phases/specification.test.ts` — new file, 159 lines, 4 `it(...)` blocks.
- `.planning/phases/03-high-priority-runtime-fixes/deferred-items.md` — new file logging out-of-scope flaky tests discovered during the full-suite sweep (interrupter timing test, optimizer mutation tests, missing `blueprint-verifier` module).

## Decisions Made

- **Did NOT rewrite `runSpecification`.** Per the plan, the file was already a real handler in the current tree (verified via grep + import audit). The HIGH-04 closure value is the regression net, not new code.
- **Used a structural schema violation (omit `integrationBoundaries`) for Test 4** instead of the plan's proposed count violation on `outOfScope.min(2)` — the actual `DetailedSpecSchema` (src/types/llm-schemas.ts:445) uses bare `z.array(z.string())` with no `.min(N)`, so the planned fixture would have parsed cleanly and the test would have failed to fail. Fixture rewritten to trigger a real Zod rejection.
- **Did NOT chase pre-existing flaky tests.** `tests/events/interrupter.test.ts` (1 timing-based fail), `tests/self-improve/optimizer.test.ts` (3 intermittent fails), and `tests/self-improve/blueprint-verifier.test.ts` (module-not-found, pre-existing in baseline) all surfaced during the full-suite sweep but are unrelated to specification.ts. Logged to `deferred-items.md` per SCOPE BOUNDARY rule.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] Test 4 fixture rewritten to trigger a real schema violation**
- **Found during:** Task 2 (writing tests/phases/specification.test.ts).
- **Issue:** Plan §`<behavior>` Test 4 specified `outOfScope: ["Only one item"]` to trigger `.min(2)` rejection. Inspection of `src/types/llm-schemas.ts:445` shows `outOfScope: z.array(z.string())` with NO `.min(N)` constraint — the planned malformed payload would have passed validation, and the test would have asserted `success: false` against an actual `success: true`, failing for the wrong reason.
- **Fix:** Test 4 now omits the required top-level `integrationBoundaries` field entirely (`const { integrationBoundaries: _omit, ...malformed } = validDetailedSpec`). This is a genuine structural violation that `DetailedSpecSchema.safeParse` actually rejects with a "Required" error, confirming the handler's failure path on real-world bad data.
- **Files modified:** tests/phases/specification.test.ts (Test 4 only).
- **Verification:** Test passes — handler returns `error: /specification: invalid DetailedSpec JSON/` as expected.
- **Committed in:** `9b0c675` (Task 2 commit).

---

**Total deviations:** 1 auto-fixed (1 Rule 1 — bug correction in test fixture).
**Impact on plan:** None on scope. The fix preserves the test's intent ("schema-violation path is tested") while making it actually exercise a Zod rejection rather than a no-op.

## Issues Encountered

- **Pre-existing flaky tests surfaced during the full-suite sweep** (`interrupter`, `optimizer`, `blueprint-verifier`). Confirmed pre-existing via `git stash` + isolated run — 1 failure persists in `interrupter.test.ts` even with my changes reverted. Logged to `.planning/phases/03-high-priority-runtime-fixes/deferred-items.md`. Out of scope per SCOPE BOUNDARY rule (none touch `src/phases/specification.ts`).

## User Setup Required

None — no external service or config change.

## Next Phase Readiness

- **HIGH-04 closed.** REQUIREMENTS.md acceptance criterion #4 ("`src/phases/specification.ts` is a real handler (not a stub) and the previous circular import is gone; `npm run typecheck` confirms") fully satisfied with regression net.
- **No blockers** for HIGH-05 / HIGH-06 (next plans in this phase). They share zero source surface with specification.ts.
- **Watch-out:** the flakes in `interrupter.test.ts` and `optimizer.test.ts` should be stabilized in a dedicated plan before Phase 4 (end-to-end validation), otherwise they will mask real regressions.

## Self-Check: PASSED

- `src/phases/specification.ts` exists and contains the JSDoc header (`grep -c "HIGH-04" src/phases/specification.ts` → 1; `grep -cE "throw new Error.*\bstub\b|// TODO: stub" src/phases/specification.ts` → 0).
- `tests/phases/specification.test.ts` exists with 4 `it(...)` blocks and passes (`npm test -- --run tests/phases/specification.test.ts` → 4 passed).
- `npm run typecheck` → exits 0.
- `npm run lint` → exits 0.
- Commits exist in `git log`: `cfeb319` (Task 1), `9b0c675` (Task 2).
- `.planning/phases/03-high-priority-runtime-fixes/deferred-items.md` exists with the out-of-scope flake catalogue.

---
*Phase: 03-high-priority-runtime-fixes*
*Completed: 2026-04-22*
