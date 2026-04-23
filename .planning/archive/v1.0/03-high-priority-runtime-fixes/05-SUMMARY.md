---
phase: 03-high-priority-runtime-fixes
plan: 05
subsystem: self-improvement
tags: [zod, blueprint-verifier, optimizer-runner, verification-gate, high-05, threat-mitigation]

# Dependency graph
requires:
  - phase: 02-critical-security-backlog-closure
    provides: stable ConfigSchema + pinned SDK so the verifier's AgentBlueprintSchema call-site is unambiguous
provides:
  - Pure-function verifier `verifyBlueprint(candidate)` with discriminated `VerificationResult` union
  - Deterministic gate inserted between `mutation.apply()` and `registry.register()` in optimizer-runner
  - Tool allow-list (static Set + `mcp__` prefix rule) mitigating T-03-05-02 (tool-escape elevation of privilege)
  - Evolution-log observability: rejected mutations carry `accepted:false` + `REJECTED: verification failed — {reason}` diff prefix
affects: [self-improve loop, prompt versioning, benchmark-cost accounting, evolution-log forensics]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Verifier-gate pattern: pure synchronous function placed BEFORE registry writes and BEFORE expensive async work; failure appends a tagged evolution entry and continues the loop."
    - "Discriminated union for verification results: `{ ok: true; blueprint } | { ok: false; reason }` for clean narrowing at call sites."
    - "Static allow-list + prefix rule: explicit Set for hand-configured tools + `name.startsWith('mcp__')` for dynamic MCP tools — no wildcard match."

key-files:
  created:
    - src/self-improve/blueprint-verifier.ts
    - tests/self-improve/blueprint-verifier.test.ts
  modified:
    - src/self-improve/optimizer-runner.ts (2 edits: import + gate block in mutation loop)
    - tests/self-improve/optimizer-runner.test.ts (fixture prompts lengthened + new HIGH-05 integration test)
    - tests/self-improve/optimizer.test.ts (fixture prompts lengthened — Rule 1 auto-fix)
    - .planning/phases/03-high-priority-runtime-fixes/deferred-items.md (re-observed flake notes)

key-decisions:
  - "Verifier is pure: no async, no filesystem, no network, no LLM. Cheap enough to run on every mutation, cannot fail open under load (T-03-05 mitigation disposition pinned in the plan)."
  - "Gate runs BEFORE registry.register(mutatedBlueprint): rejection does NOT require rollback because the registry still holds the pre-mutation blueprint. This is strictly simpler than a post-register gate with rollback."
  - "Schema check runs first via AgentBlueprintSchema.safeParse. Every downstream check assumes the candidate is already structurally valid, so we fail fast on malformed LLM output and the Zod error message is returned verbatim in the reason."
  - "Prompt bounds: 51-char minimum (strictly > 50), 20,000-char maximum. Upper bound is the DoS guard for T-03-05-03 (token explosion)."
  - "Tool allow-list uses a ReadonlySet<string> + `mcp__` prefix; no regex, no wildcard. Easy to extend by adding to the set literal; narrow and easy to review."
  - "Rejected mutations still tick updateConvergence with the unchanged baseline — stagnation counter still fires so the optimizer doesn't loop forever on a bad mutation generator."
  - "Rule 1 fix scope: the gate's 51-char minimum invalidated synthetic short-string fixtures in pre-existing optimizer.test.ts (3 tests) and optimizer-runner.test.ts (5 tests that set short mutation prompts). Fixtures lengthened to real-looking prompts; zero behavior change to production code."

patterns-established:
  - "Deterministic pre-IO verification gate: for any subsystem that mutates state AND then does expensive async work (benchmark runs, network, large writes), place a pure-function verifier BEFORE the first side-effect. Failure path logs, preserves baseline, moves on."
  - "`_TEST_EXPORTS` pattern: const-assert exported object bundling internal bounds constants so test files can assert exact min/max without duplicating literals or reaching for private fields."

requirements-completed: [HIGH-05]

# Metrics
duration: ~66 min (wall-clock; dominated by full-suite test runs under parallel load)
completed: 2026-04-22
---

# Phase 03 Plan 05: HIGH-05 — Blueprint Verification Gate Summary

**Pure-function `verifyBlueprint(candidate)` inserted as a synchronous gate between `mutation.apply()` and `registry.register()` in `src/self-improve/optimizer-runner.ts`. Rejected mutations skip the benchmark run entirely and never reach `savePromptVersion` — the only path to `.autonomous-dev/agents/{name}.v{N}.md` is now guarded by schema validation, prompt length bounds, a tool allow-list, and non-empty name/role checks.**

## Performance

- **Duration:** ~66 min
- **Started:** 2026-04-22T19:09:00Z
- **Completed:** 2026-04-22T20:15:00Z
- **Tasks:** 5 (all completed)
- **Files created:** 2 (1 source, 1 test)
- **Files modified:** 3 (1 source, 2 test) + 1 supporting doc (deferred-items.md)
- **Tests added:** +9 (8 unit in blueprint-verifier.test.ts; 1 integration in optimizer-runner.test.ts)
- **Final test count:** 820 passing, self-improve subtree 88/88

## Accomplishments

### 1. New module: `src/self-improve/blueprint-verifier.ts`

Full content:

```ts
/**
 * HIGH-05 — Blueprint verification gate.
 *
 * Runs synchronously between `mutation.apply()` and `registry.register()` in
 * `src/self-improve/optimizer-runner.ts`. Deterministic, pure-function checks:
 * schema validation (Zod), prompt length bounds, tool allow-list, non-empty
 * name/role. No network, no filesystem, no LLM — the entire point is that
 * verification is cheap enough to run on every mutation and cannot fail open
 * under load.
 *
 * Rejecting a blueprint here short-circuits the expensive benchmark run and
 * guarantees no unverified blueprint is ever written to
 * `.autonomous-dev/agents/{name}.v{N}.md` via `savePromptVersion`.
 */
import type { AgentBlueprint } from "../state/project-state.js";
import { AgentBlueprintSchema } from "../types/llm-schemas.js";

const ALLOWED_TOOLS: ReadonlySet<string> = new Set<string>([
  "Read", "Write", "Edit", "Bash", "Glob", "Grep",
  "WebSearch", "WebFetch", "Agent", "Task",
]);

const SYSTEM_PROMPT_MIN_CHARS = 51; // strictly greater than 50
const SYSTEM_PROMPT_MAX_CHARS = 20_000;

export type VerificationResult =
  | { ok: true; blueprint: AgentBlueprint }
  | { ok: false; reason: string };

function isAllowedTool(name: string): boolean {
  if (ALLOWED_TOOLS.has(name)) return true;
  if (name.startsWith("mcp__")) return true;
  return false;
}

export function verifyBlueprint(candidate: unknown): VerificationResult {
  // Step 1 — schema validity.
  const parsed = AgentBlueprintSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, reason: `schema_invalid: ${parsed.error.message}` };
  }
  const blueprint: AgentBlueprint = parsed.data;

  // Step 2 — prompt lower bound.
  if (blueprint.systemPrompt.length < SYSTEM_PROMPT_MIN_CHARS) {
    return {
      ok: false,
      reason: `system_prompt_too_short: length=${blueprint.systemPrompt.length} minimum=${SYSTEM_PROMPT_MIN_CHARS}`,
    };
  }

  // Step 3 — prompt upper bound (DoS guard).
  if (blueprint.systemPrompt.length > SYSTEM_PROMPT_MAX_CHARS) {
    return {
      ok: false,
      reason: `system_prompt_too_long: length=${blueprint.systemPrompt.length} maximum=${SYSTEM_PROMPT_MAX_CHARS}`,
    };
  }

  // Step 4 — tools non-empty.
  if (blueprint.tools.length === 0) {
    return { ok: false, reason: "tools_empty" };
  }

  // Step 5 — every tool allowed.
  for (const tool of blueprint.tools) {
    if (!isAllowedTool(tool)) {
      return { ok: false, reason: `disallowed_tool: ${tool}` };
    }
  }

  // Step 6 — name and role non-empty after trim.
  if (blueprint.name.trim().length === 0) {
    return { ok: false, reason: "empty_name" };
  }
  if (blueprint.role.trim().length === 0) {
    return { ok: false, reason: "empty_role" };
  }

  return { ok: true, blueprint };
}

export const _TEST_EXPORTS = {
  ALLOWED_TOOLS,
  SYSTEM_PROMPT_MIN_CHARS,
  SYSTEM_PROMPT_MAX_CHARS,
} as const;
```

### 2. `src/self-improve/optimizer-runner.ts` — gate insertion

**Edit 1 — import (line 24):**
```ts
import { verifyBlueprint } from "./blueprint-verifier.js";
```

**Edit 2 — gate block inside the `for (const mutation of mutations)` loop, immediately after `const mutatedBlueprint = mutation.apply();` and BEFORE `registry.register(mutatedBlueprint);` (lines 197-235):**

```ts
const mutatedBlueprint = mutation.apply();

// HIGH-05 — Blueprint verification gate. Before we register the
// candidate and spend benchmark cost, check it passes deterministic
// verification (schema, prompt length bounds, tool allow-list,
// non-empty name/role). A rejected mutation is recorded in the
// evolution log with `accepted: false` and a
// `REJECTED: verification failed — ...` diff prefix, so post-run
// forensics can see WHY it was dropped. The gate runs BEFORE
// `registry.register`, so the registry still holds the pre-mutation
// blueprint — no rollback is needed on rejection.
const verification = verifyBlueprint(mutatedBlueprint);
if (!verification.ok) {
  console.warn(
    `[optimizer] Rejecting mutation "${mutation.description}" — verification failed: ${verification.reason}`
  );
  const rejectedEntry: EvolutionEntry = {
    id: randomUUID(),
    target: mutation.targetName,
    type: mutation.type,
    diff: `REJECTED: verification failed — ${verification.reason}`,
    scoreBefore: currentState.baselineScore,
    scoreAfter: currentState.baselineScore,
    accepted: false,
    timestamp: new Date().toISOString(),
  };
  currentState = {
    ...currentState,
    evolution: [...currentState.evolution, rejectedEntry],
  };
  saveState(config.stateDir, currentState);
  // Baseline unchanged → stagnation counter ticks.
  convergenceState = updateConvergence(
    convergenceState,
    currentState.baselineScore,
    convergenceConfig
  );
  continue;
}

registry.register(mutatedBlueprint);
```

### 3. `savePromptVersion(mutatedBlueprint)` call at line ~345 — UNCHANGED

Confirmed via `grep -n "savePromptVersion" src/self-improve/optimizer-runner.ts`:
- Line 145: `savePromptVersion(config.stateDir, agent);` (baseline save — unchanged)
- Line 345: `savePromptVersion(config.stateDir, mutatedBlueprint);` (accept branch — unchanged)

The gate is additive — zero changes to the pre-existing accept branch, the hybrid-weighted scoring logic (lines 304-320), or the rollback path.

### 4. Test coverage: 9 new tests

**`tests/self-improve/blueprint-verifier.test.ts` (8 tests):**
1. `accepts a valid blueprint`
2. `rejects when schema validation fails (missing required field)`
3. `rejects when systemPrompt is too short`
4. `rejects when systemPrompt exceeds the 20_000-char upper bound`
5. `rejects when tools array is empty`
6. `rejects disallowed tool names`
7. `accepts mcp__-prefixed tool names`
8. `rejects when name is whitespace-only`

**`tests/self-improve/optimizer-runner.test.ts` (1 new test):**
- `rejects mutation with invalid blueprint without running benchmarks or savePromptVersion (HIGH-05)` — asserts:
  - `mockRunAllBenchmarks` called exactly 1 time (baseline only; mutation does NOT trigger a second call)
  - `savePromptVersion` never called with `systemPrompt: ""`
  - `state.evolution` has exactly 1 entry, `accepted:false`, diff prefixed `REJECTED: verification failed`
  - `scoreBefore === scoreAfter` (baseline preserved)

## All possible `VerificationResult.reason` values

Enumerated set of rejection reasons returned by `verifyBlueprint`:

| Reason prefix | Trigger |
|---------------|---------|
| `schema_invalid: <ZodError>` | `AgentBlueprintSchema.safeParse` failed (missing required field, wrong type, etc.) |
| `system_prompt_too_short: length=N minimum=51` | `systemPrompt.length < 51` |
| `system_prompt_too_long: length=N maximum=20000` | `systemPrompt.length > 20000` |
| `tools_empty` | `tools.length === 0` |
| `disallowed_tool: <name>` | Tool not in `ALLOWED_TOOLS` set AND does not start with `mcp__` |
| `empty_name` | `name.trim().length === 0` |
| `empty_role` | `role.trim().length === 0` |

On success: `{ ok: true, blueprint: parsed.data }` — no reason field.

## Commits (in order)

| # | Commit | Type | Message |
|---|--------|------|---------|
| 1 | `57db14c` | test | `test(03-05): add failing tests for blueprint verifier (HIGH-05)` — RED (8 failing tests) |
| 2 | `a1a4191` | feat | `feat(03-05): implement blueprint verifier gate (HIGH-05)` — GREEN (pure-function module) |
| 3 | `78f4bde` | test | `test(03-05): add failing optimizer-runner integration test for verifier gate (HIGH-05)` — RED |
| 4 | `ea140df` | feat | `feat(03-05): wire verifyBlueprint gate into optimizer-runner (HIGH-05)` — GREEN + Rule 1 fixture fixes |

## Deviations from Plan

### Auto-fixed (Rule 1 — bug caused directly by this task's changes)

**1. [Rule 1] Pre-existing tests with synthetic short prompts broke after gate insertion**

- **Found during:** Task 5 (full-suite test sweep)
- **Issue:** Three tests in `tests/self-improve/optimizer.test.ts` (`accepts mutations that improve the score`, `rejects mutations that do not improve the score`, `runs multiple iterations accepting and rejecting`) and five tests in `tests/self-improve/optimizer-runner.test.ts` (`accepts a mutation that improves the score`, `records a rejected evolution entry when worktree output cannot be parsed`, `recovers from benchmark evaluation failure without leaking the mutation`, and two hybrid-acceptance tests) used synthetic 15-char prompts (`"You write code."`, `"Better prompt"`, `"Mutated"`, `"Broken"`, `"Risky change"`) in mutation payloads. The new 51-char minimum caused the verifier to reject these mutations BEFORE they reached the score-comparison branch being asserted.
- **Fix:** Replaced the short prompts with 51+ char variants (e.g., `"You are a careful software engineer. Write tested, reviewed code."`). Zero behavior change to production code; only test fixtures updated. The tests now exercise the post-verification score code paths they were designed to test.
- **Files modified:** `tests/self-improve/optimizer-runner.test.ts`, `tests/self-improve/optimizer.test.ts`
- **Commit:** `ea140df`

### Out-of-scope discoveries (logged, NOT fixed)

Appended to `.planning/phases/03-high-priority-runtime-fixes/deferred-items.md`:

- `tests/events/interrupter.test.ts > signal aborts in-flight consumeQuery within 100ms` — timing flake under full-suite parallel load (elapsed=289ms > 100ms budget). Passes 11/11 in isolation. Pre-existing; same flake already documented under Plan 03-01 and 03-04 sections.
- `tests/integration/pipeline.test.ts > runs ideation → specification → architecture → environment-setup` — times out at 5000ms under full-suite import contention. Passes 4/4 in isolation. Pre-existing; same flake already documented under Plan 03-02 and 03-01 sections.

**Resolved by this plan (cross-referenced in deferred-items.md):** the earlier entry noting `tests/self-improve/blueprint-verifier.test.ts` as missing its source module is now fixed — this plan created `src/self-improve/blueprint-verifier.ts` and rewrote the test file with 8 passing cases.

## Verification commands (all passed)

```bash
# Gate ordering sanity — verifyBlueprint call precedes registry.register:
grep -nE "verifyBlueprint\(mutatedBlueprint\)|registry\.register\(mutatedBlueprint\);" src/self-improve/optimizer-runner.ts
#   206:      const verification = verifyBlueprint(mutatedBlueprint);
#   236:      registry.register(mutatedBlueprint);

# verifyBlueprint import + call count:
grep -c "verifyBlueprint" src/self-improve/optimizer-runner.ts
#   2

# Module purity:
grep -cE "^\s*(await |import.*node:fs|import.*node:child_process)" src/self-improve/blueprint-verifier.ts
#   0

# Typecheck / test / lint:
npm run typecheck  # exit 0
npm test -- --run tests/self-improve/  # 88/88 pass across 9 files
npm run lint       # 0 errors (1 pre-existing warning in src/phases/development-runner.ts, unrelated to HIGH-05)
```

## Threat Model Outcome

| Threat ID | Category | Disposition | Status |
|-----------|----------|-------------|--------|
| T-03-05-01 | Tampering (poisoned blueprint persisted across runs) | mitigate | Closed — `verifyBlueprint` runs before both `registry.register` and `savePromptVersion`; rejected mutations tagged in evolution log. |
| T-03-05-02 | Elevation of Privilege (tool allow-list bypass via non-`mcp__` prefix) | mitigate | Closed — `ALLOWED_TOOLS` is a `ReadonlySet<string>` + strict `startsWith("mcp__")` check; no wildcard, no regex. |
| T-03-05-03 | DoS (very large prompt causing SDK/cost explosion) | mitigate | Closed — 20,000-char upper bound enforced. |
| T-03-05-04 | Tampering (verifier bypass via `_TEST_EXPORTS` mutation) | accept | Accepted — `_TEST_EXPORTS` is non-production, only exposes bounds constants for assertion. Runtime behavior is not gated by this object. |

## Success Criteria Check

- [x] HIGH-05 acceptance criterion #5 holds: unverified blueprints never reach `registry.register`, `runAllBenchmarks`, or `savePromptVersion`.
- [x] Rejected mutations observable in `state.evolution[]` with `accepted: false` and `REJECTED: verification failed — {reason}` diff.
- [x] +9 tests added, 100% pass; no existing test regresses (self-improve subtree 88/88).
- [x] `npm run typecheck` exits 0.
- [x] `npm test` exits 0 for focused self-improve run (2 unrelated flaky tests in full-suite run under parallel load — both pass in isolation and logged as out-of-scope).
- [x] `npm run lint` exits 0 errors (1 pre-existing warning, not from this plan).

## Self-Check: PASSED

- `src/self-improve/blueprint-verifier.ts` — FOUND
- `tests/self-improve/blueprint-verifier.test.ts` — FOUND
- `src/self-improve/optimizer-runner.ts` — FOUND (modified)
- `tests/self-improve/optimizer-runner.test.ts` — FOUND (modified)
- `tests/self-improve/optimizer.test.ts` — FOUND (modified, Rule 1 auto-fix)
- `.planning/phases/03-high-priority-runtime-fixes/deferred-items.md` — FOUND (updated)
- Commit `57db14c` (RED verifier tests) — FOUND
- Commit `a1a4191` (GREEN verifier impl) — FOUND
- Commit `78f4bde` (RED optimizer-runner integration test) — FOUND
- Commit `ea140df` (GREEN gate wiring + Rule 1 fixture fix) — FOUND
