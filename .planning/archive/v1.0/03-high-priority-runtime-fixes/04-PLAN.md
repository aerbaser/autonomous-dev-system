---
phase: 03-high-priority-runtime-fixes
plan: 04
type: execute
wave: 1
depends_on: []
files_modified:
  - src/phases/specification.ts
  - tests/phases/specification.test.ts
autonomous: true
requirements:
  - HIGH-04
must_haves:
  truths:
    - "src/phases/specification.ts is a fully-functional phase handler — no stub branches, no TODO placeholders, no hardcoded fallback returns that bypass the LLM call"
    - "specification.ts imports only: @anthropic-ai/claude-agent-sdk (query), ../utils/config.js (Config), ../state/project-state.js (ProjectState, ProductSpec types), ./types.js (PhaseResult, PhaseExecutionContext), ../utils/sdk-helpers.js (consumeQuery, getQueryPermissions, getMaxTurns), ../utils/shared.js (extractFirstJson, errMsg, wrapUserInput), ../types/llm-schemas.js (DetailedSpecSchema, DetailedSpec type) — verified via explicit import list"
    - "There is NO circular import path A → B → ... → A involving specification.ts; npm run typecheck surfaces no circular-type errors, AND tsc --noEmit --extendedDiagnostics reports zero cycles attributable to specification.ts"
    - "A new test file tests/phases/specification.test.ts covers: (a) returns success + sets state.spec.detailed, (b) returns failure if state.spec missing, (c) returns failure if the LLM returns malformed JSON, (d) returns failure if JSON fails DetailedSpecSchema validation"
    - "The test file uses the established vi.mock('@anthropic-ai/claude-agent-sdk') + makeStream pattern used by tests/phases/*.test.ts"
    - "npm run typecheck exits 0"
    - "npm test exits 0 (preserves the baseline; +4 new tests)"
    - "npm run lint exits 0"
  artifacts:
    - path: "src/phases/specification.ts"
      provides: "Real runSpecification handler that expands ProductSpec.detailed via LLM + Zod; no stub; no circular import"
      contains: "consumeQuery"
    - path: "tests/phases/specification.test.ts"
      provides: "4 unit tests covering success, missing-input, bad-JSON, schema-violation paths"
      contains: "runSpecification"
  key_links:
    - from: "src/phases/specification.ts"
      to: "src/types/llm-schemas.ts (DetailedSpecSchema)"
      via: "typed import: `import { DetailedSpecSchema, type DetailedSpec } from \"../types/llm-schemas.js\";`"
      pattern: "DetailedSpecSchema"
    - from: "src/phases/specification.ts"
      to: "src/utils/sdk-helpers.ts (consumeQuery)"
      via: "Direct import — every query goes through consumeQuery for cost accounting"
      pattern: "consumeQuery"
    - from: "src/orchestrator.ts"
      to: "src/phases/specification.ts"
      via: "import { runSpecification } from \"./phases/specification.js\";"
      pattern: "runSpecification"
---

<objective>
HIGH-04: Verify `src/phases/specification.ts` is a real handler (not a stub), resolve any residual circular import the historic stub introduced, and add a dedicated test file so the handler is covered by automated regression tests going forward. Per REQUIREMENTS.md HIGH-04 success criterion #4: "`src/phases/specification.ts` is a real handler (not a stub) and the previous circular import is gone; `npm run typecheck` confirms."

Purpose: As of the current tree, `specification.ts` already implements a real handler (reads `state.spec`, builds a wrapped prompt, calls `consumeQuery`, extracts JSON, validates with `DetailedSpecSchema.safeParse`, returns `nextPhase: "architecture"`). The module imports are clean: it imports types from `../state/project-state.js` and the Zod schema from `../types/llm-schemas.ts` — no back-import into `./types.ts` (which would close a cycle with `development-runner.ts` and friends). `npm run typecheck` is clean (811/811 baseline confirms). HIGH-04 is therefore mostly **verification + locking in the contract with tests** so a future refactor can't silently reintroduce a stub or cycle. The plan audits imports explicitly, runs `tsc --noEmit --extendedDiagnostics` to surface any latent cycle, and adds the missing `tests/phases/specification.test.ts` (the only phases test currently absent — see `ls tests/phases/` which has `ideation`, `architecture`, `development-runner`, `testing`, `review`, `environment-setup`, `deployment`, `ab-testing`, `monitoring`, but NOT `specification`).

Output: Zero behavioral changes to `src/phases/specification.ts`. (If the import audit discovers an unnecessary re-export or an import that could tighten the boundary — e.g. a type-only import needing the `type` keyword — apply it in this plan, scoped to specification.ts only.) One new file: `tests/phases/specification.test.ts` with 4 tests.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/REQUIREMENTS.md
@.planning/phases/03-high-priority-runtime-fixes/03-CONTEXT.md
@.claude/skills/typescript/SKILL.md
@src/phases/specification.ts
@src/phases/types.ts
@src/types/llm-schemas.ts
@src/utils/sdk-helpers.ts
@src/utils/shared.ts
@tests/phases/ideation.test.ts

<interfaces>
<!-- Key contracts the executor needs. Extracted from codebase. -->

From src/phases/specification.ts (current imports, lines 1-7 — verify these are the FULL import set):
```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../utils/config.js";
import type { ProjectState, ProductSpec } from "../state/project-state.js";
import type { PhaseResult, PhaseExecutionContext } from "./types.js";
import { consumeQuery, getQueryPermissions, getMaxTurns } from "../utils/sdk-helpers.js";
import { extractFirstJson, errMsg, wrapUserInput } from "../utils/shared.js";
import { DetailedSpecSchema, type DetailedSpec } from "../types/llm-schemas.js";
```

From src/phases/specification.ts (contract):
```typescript
export async function runSpecification(
  state: ProjectState,
  config: Config,
  _ctx?: PhaseExecutionContext,
): Promise<PhaseResult>;
```

From src/types/llm-schemas.ts (DetailedSpecSchema — the Zod contract):
```typescript
export const DetailedSpecSchema = z.object({
  refinedUserStories: z.array(z.object({
    id: z.string(),
    title: z.string(),
    acceptanceCriteria: z.array(z.string()).min(3),
  })),
  refinedNonFunctionalRequirements: z.array(z.object({
    category: z.string(),
    requirement: z.string(),
    threshold: z.string(),
  })),
  outOfScope: z.array(z.string()).min(2),
  integrationBoundaries: z.array(z.object({
    name: z.string(),
    description: z.string(),
  })),
});
export type DetailedSpec = z.infer<typeof DetailedSpecSchema>;
```

From src/phases/types.ts (PhaseResult — the return type):
```typescript
export interface PhaseResult {
  success: boolean;
  state: ProjectState;
  nextPhase?: Phase;
  costUsd?: number;
  durationMs?: number;
  rubricResult?: RubricResult;
  sessionId?: string;
  error?: string;
}
```

From tests/phases/ideation.test.ts (pattern to MIRROR for the new specification test file):
- `vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }))`
- A `makeStream(...)` helper that wraps a JSON payload into a single-message async iterator with `type: "result", subtype: "success", result: JSON.stringify(payload), total_cost_usd: 0.001, session_id: "s"`.
- Uses `createInitialState` from `src/state/project-state.js` to build the fixture state.

Note: The existing `DetailedSpec`-related code path is already exercised transitively by `tests/integration/pipeline.test.ts` (which mocks `runSpecification`). But there is NO unit test for `runSpecification` itself. The new `tests/phases/specification.test.ts` fills that gap.
</interfaces>

<notes_for_executor>
1. **First step is an audit, not an edit.** Run the circular-import detection (`npx tsc --noEmit --extendedDiagnostics 2>&1 | grep -iE "circ|recur"` — if nothing matches, there's no cycle). If the audit surfaces a cycle, trace it via `node --experimental-vm-modules` + `--trace-warnings` OR more simply by inspecting imports. Given the current import list above, there is almost certainly NO cycle — this plan is mostly locking in the clean state with tests.
2. **Do NOT "rewrite" specification.ts to prove it's not a stub.** The file is already real. Leave the behavior unchanged. The only edits permitted to `src/phases/specification.ts` in this plan are:
   - Converting `import type` where appropriate to tighten the type-only import boundary (already done).
   - Adding a top-of-file JSDoc block documenting the handler's contract and the HIGH-04 verification — no functional change.
3. **`ProductSpec` import from `../state/project-state.js`** — verify it is either unused OR used in a type position. If it is unused, remove it. (`grep -c "ProductSpec" src/phases/specification.ts` — must match the number of legitimate references. Currently `ProductSpec` is used in the `updatedSpec: ProductSpec = { ... }` type annotation inside the handler, so it IS used — leave it.)
4. **Test file location**: `tests/phases/specification.test.ts` — note the path uses `tests/phases/` (not `tests/integration/`). This matches the convention set by `tests/phases/ideation.test.ts`, `tests/phases/architecture.test.ts`, etc.
5. **Test fixtures must include a valid `state.spec`** so the handler's early-out (`if (!state.spec)`) returns success-path for the happy-case tests. The fixture spec can reuse the minimal shape used in `tests/integration/orchestrator.test.ts` (look for `specFixture` or a similar object in the existing pipeline tests).
6. **TypeScript strict** — `noUncheckedIndexedAccess` applies to `parsed.data.refinedUserStories[0]` etc. Guard before accessing in tests.
</notes_for_executor>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Audit specification.ts imports + circular-import check + documentation</name>
  <files>src/phases/specification.ts</files>
  <action>
**Step 1 — Verify import list.** Open `src/phases/specification.ts` and confirm the imports match the list in `<interfaces>` above. If any import deviates (extra or missing), record it for the SUMMARY but do NOT remove imports that are genuinely used.

**Step 2 — Circular-import audit (read-only):**

Run each of these commands and capture their output for the SUMMARY:
```bash
npx tsc --noEmit --extendedDiagnostics 2>&1 | grep -iE "circ|recur" || echo "NO CYCLES DETECTED"
grep -rn "from.*phases/specification" src/ tests/ --include="*.ts" 2>/dev/null
grep -rn "from.*types/llm-schemas" src/phases/specification.ts 2>/dev/null
```

The expected outcome is "NO CYCLES DETECTED" — HIGH-04's circular-import concern was historical (from a stub version that has since been replaced). If the audit surfaces an actual cycle, scope-creep this plan to fix it and record the cycle chain in the SUMMARY. If no cycle is present, proceed.

**Step 3 — Prepend a JSDoc header block documenting the handler's contract + HIGH-04 closure.**

Before (top of `src/phases/specification.ts`, line 1):
```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
```

After:
```ts
/**
 * Phase: specification (#2 in the 12-phase lifecycle).
 *
 * Takes the coarse `state.spec` produced by ideation and expands it into
 * implementation-ready detail:
 *   - refined user stories with 3+ Given/When/Then acceptance criteria each
 *   - non-functional requirements with concrete thresholds (no "fast" / "secure")
 *   - explicit out-of-scope list (≥ 2 items)
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
import { query } from "@anthropic-ai/claude-agent-sdk";
```

**Step 4 — Self-check:**

```bash
grep -c "HIGH-04" src/phases/specification.ts  # must be ≥ 1
grep -c "stub" src/phases/specification.ts      # must be 0 (outside the JSDoc-proved `not a stub`)
npx tsc --noEmit                                # must exit 0
```
  </action>
  <verify>
    <automated>npm run typecheck && grep -c "HIGH-04" src/phases/specification.ts | awk '$1 >= 1 { exit 0 } { exit 1 }' && test $(grep -cE "^\s*throw new Error.*\bstub\b|^\s*//\s*TODO:?\s*stub" src/phases/specification.ts) -eq 0</automated>
  </verify>
  <done>
- `src/phases/specification.ts` has a JSDoc header documenting the real-handler contract and the HIGH-04 closure rationale.
- Circular-import audit recorded in the SUMMARY (expected: "NO CYCLES DETECTED").
- Grep audit confirms zero `throw new Error(...stub...)` or `// TODO: stub` markers.
- `npm run typecheck` exits 0.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Add tests/phases/specification.test.ts covering the 4 behaviors</name>
  <files>tests/phases/specification.test.ts</files>
  <behavior>
    - Test 1 (`'returns success and populates state.spec.detailed with parsed DetailedSpec'`): the mocked LLM returns a valid `DetailedSpec` JSON payload. The handler MUST return `{ success: true, nextPhase: "architecture" }` with `result.state.spec.detailed` matching the mocked payload (byte-for-byte equality on the parsed object).
    - Test 2 (`'returns failure when state.spec is missing'`): input state has `spec: null`. The handler MUST return `{ success: false, error: "No spec found. Run ideation first." }` WITHOUT calling the SDK query (`expect(mockedQuery).not.toHaveBeenCalled()`).
    - Test 3 (`'returns failure when the LLM response contains no valid JSON'`): the mocked LLM returns plain text ("Here is the spec as prose ..."). The handler MUST return `{ success: false, error: "specification: no valid JSON in LLM output" }`.
    - Test 4 (`'returns failure when the extracted JSON does not satisfy DetailedSpecSchema'`): the mocked LLM returns a JSON object missing required fields (e.g. `outOfScope` has fewer than 2 items, which `.min(2)` rejects). The handler MUST return `{ success: false, error: /specification: invalid DetailedSpec JSON/ }`.
  </behavior>
  <action>
Create `tests/phases/specification.test.ts` from scratch, matching the style of `tests/phases/ideation.test.ts`.

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Config } from "../../src/utils/config.js";
import { createInitialState } from "../../src/state/project-state.js";
import type { ProjectState } from "../../src/state/project-state.js";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));

const { query } = await import("@anthropic-ai/claude-agent-sdk");
const mockedQuery = vi.mocked(query);
const { runSpecification } = await import("../../src/phases/specification.js");

function makeStream(resultText: string) {
  return {
    [Symbol.asyncIterator]() {
      let done = false;
      return {
        async next() {
          if (done) return { value: undefined, done: true as const };
          done = true;
          return {
            value: {
              type: "result" as const,
              subtype: "success" as const,
              result: resultText,
              session_id: "specification-session",
              total_cost_usd: 0.001,
              num_turns: 1,
            },
            done: false as const,
          };
        },
      };
    },
    close() {},
  } as any;
}

function makeConfig(): Config {
  return {
    model: "claude-sonnet-4-6",
    subagentModel: "claude-sonnet-4-6",
    selfImprove: { enabled: false, maxIterations: 50, nightlyOptimize: false },
    projectDir: ".",
    stateDir: ".autonomous-dev",
    memory: { enabled: false, maxDocuments: 500, maxDocumentSizeKb: 100 },
    rubrics: { enabled: false, maxIterations: 3 },
  } as Config;
}

function makeStateWithSpec(): ProjectState {
  const base = createInitialState("build a todo app with tags");
  return {
    ...base,
    spec: {
      summary: "A todo app with tagged tasks and due dates",
      userStories: [
        {
          id: "US-001",
          title: "Create a task",
          description: "Users can add a new task to their list",
          priority: "must",
          acceptanceCriteria: ["Given a logged-in user, When they submit a task, Then it appears in the list"],
        },
      ],
      nonFunctionalRequirements: ["Fast response times"],
      domain: {
        classification: "productivity",
        specializations: [],
        requiredRoles: [],
        requiredMcpServers: [],
        techStack: [],
      },
    },
  };
}

const validDetailedSpec = {
  refinedUserStories: [
    {
      id: "US-001",
      title: "Create a task",
      acceptanceCriteria: [
        "Given a logged-in user, When they submit a task with a title, Then it appears at the top of their list",
        "Given an empty title, When they attempt to submit, Then an inline error is shown and the task is NOT created",
        "Given a network failure during submit, When the request is retried, Then no duplicate task is created",
      ],
    },
  ],
  refinedNonFunctionalRequirements: [
    {
      category: "performance",
      requirement: "P95 response time under load",
      threshold: "p95 < 200ms at 100 RPS",
    },
  ],
  outOfScope: [
    "Multi-tenant task sharing",
    "Offline mode with conflict resolution",
  ],
  integrationBoundaries: [
    {
      name: "Auth provider",
      description: "OAuth2 via Clerk; failure → 401 + prompt to re-authenticate",
    },
  ],
};

describe("runSpecification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns success and populates state.spec.detailed with parsed DetailedSpec", async () => {
    mockedQuery.mockReturnValue(makeStream(JSON.stringify(validDetailedSpec)));

    const result = await runSpecification(makeStateWithSpec(), makeConfig());

    expect(result.success).toBe(true);
    expect(result.nextPhase).toBe("architecture");
    expect(result.state.spec?.detailed).toEqual(validDetailedSpec);
    expect(mockedQuery).toHaveBeenCalledTimes(1);
  });

  it("returns failure when state.spec is missing", async () => {
    const stateNoSpec = { ...createInitialState("idea"), spec: null };
    const result = await runSpecification(stateNoSpec, makeConfig());

    expect(result.success).toBe(false);
    expect(result.error).toBe("No spec found. Run ideation first.");
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("returns failure when the LLM response contains no valid JSON", async () => {
    mockedQuery.mockReturnValue(makeStream("Here is the spec as prose — no JSON. Sorry."));

    const result = await runSpecification(makeStateWithSpec(), makeConfig());

    expect(result.success).toBe(false);
    expect(result.error).toBe("specification: no valid JSON in LLM output");
  });

  it("returns failure when the extracted JSON does not satisfy DetailedSpecSchema", async () => {
    // outOfScope has only 1 item; schema requires .min(2).
    const malformed = {
      ...validDetailedSpec,
      outOfScope: ["Only one item"],
    };
    mockedQuery.mockReturnValue(makeStream(JSON.stringify(malformed)));

    const result = await runSpecification(makeStateWithSpec(), makeConfig());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/specification: invalid DetailedSpec JSON/);
  });
});
```

**Self-check:**
- File `tests/phases/specification.test.ts` exists with 4 `it(...)` blocks.
- `grep -c "runSpecification" tests/phases/specification.test.ts` returns ≥ 5 (import + 4 call sites).
- `npm test -- --run tests/phases/specification.test.ts` passes.
  </action>
  <verify>
    <automated>npm test -- --run tests/phases/specification.test.ts</automated>
  </verify>
  <done>
- `tests/phases/specification.test.ts` exists with the 4 tests specified.
- All 4 pass against the current (unchanged) `src/phases/specification.ts`.
  </done>
</task>

<task type="auto">
  <name>Task 3: Full test sweep + lint</name>
  <files>(no files modified — verification-only)</files>
  <action>
1. `npm run typecheck`.
2. `npm test` — full suite. Count should be ≥ prior baseline + 4 new tests.
3. `npm run lint`.
4. For SUMMARY: record the imports-used list for `src/phases/specification.ts` and confirm the circular-import audit returned "NO CYCLES DETECTED".
  </action>
  <verify>
    <automated>npm run typecheck && npm test && npm run lint</automated>
  </verify>
  <done>
- `npm run typecheck` exits 0.
- `npm test` exits 0; test count increased by 4.
- `npm run lint` exits 0.
- SUMMARY records: (a) imports audited, (b) JSDoc block added, (c) 4 tests added, (d) circular-import audit outcome.
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| LLM grader output → specification handler | Untrusted; parsed via `extractFirstJson` + `DetailedSpecSchema.safeParse` |
| state.spec (from ideation) → specification prompt | Previously-LLM-authored; wrapped via `wrapUserInput` in 5 distinct tag blocks |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-03-04-01 | Tampering | Malformed JSON injection into DetailedSpec | mitigate | Zod `.safeParse` rejects; failure path returns `{ success: false }` (already implemented; now tested). |
| T-03-04-02 | Elevation of Privilege | A future stub re-introduction silently bypassing the LLM | mitigate | New unit tests exercise the real handler; a stub that short-circuits would break tests. |
| T-03-04-03 | Tampering | Circular import forcing partial module at load time | mitigate | JSDoc explicitly names the one-direction import boundary; audit is part of this plan. |
</threat_model>

<verification>
End-to-end checks for this plan:
- `grep -cE "^\s*(throw new Error.*\bstub\b|// TODO: stub)" src/phases/specification.ts` = 0
- `grep -c "HIGH-04" src/phases/specification.ts` ≥ 1 (JSDoc header)
- `tests/phases/specification.test.ts` exists with 4 `it(...)` blocks
- `npm run typecheck && npm test && npm run lint` all green
- Circular-import audit (`npx tsc --noEmit --extendedDiagnostics | grep -iE "circ|recur" || true`) produces no cycle attributable to specification.ts
</verification>

<success_criteria>
- HIGH-04 acceptance criterion #4 holds: `src/phases/specification.ts` is a real handler; no circular import; `npm run typecheck` confirms.
- A dedicated test file locks in the contract so future refactors can't regress.
- 4 new tests pass.
</success_criteria>

<output>
After completion, create `.planning/phases/03-high-priority-runtime-fixes/03-04-SUMMARY.md` with:
- The exact JSDoc block added to `src/phases/specification.ts`.
- Full verbatim import list of the file (7 imports).
- Circular-import audit outcome (expected: "NO CYCLES DETECTED").
- The 4 new test names with one-line descriptions each.
- Test count delta (+4) and clean lint/typecheck confirmation.
</output>
