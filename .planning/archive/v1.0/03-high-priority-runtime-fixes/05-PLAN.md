---
phase: 03-high-priority-runtime-fixes
plan: 05
type: execute
wave: 1
depends_on: []
files_modified:
  - src/self-improve/blueprint-verifier.ts
  - src/self-improve/optimizer-runner.ts
  - tests/self-improve/blueprint-verifier.test.ts
  - tests/self-improve/optimizer-runner.test.ts
autonomous: true
requirements:
  - HIGH-05
must_haves:
  truths:
    - "A new verifier module src/self-improve/blueprint-verifier.ts exports verifyBlueprint(candidate) returning a discriminated VerificationResult — pure deterministic checks, no network, no LLM, no filesystem"
    - "verifyBlueprint enforces: (a) AgentBlueprintSchema.safeParse succeeds, (b) systemPrompt length > 50 chars, (c) systemPrompt length < 20000 chars, (d) tools array is non-empty AND every tool is in the allowed SDK tool set OR starts with 'mcp__', (e) name and role are non-empty after trim"
    - "optimizer-runner.ts invokes verifyBlueprint on each mutated blueprint BEFORE calling registry.register(mutatedBlueprint) and BEFORE running benchmarks; verification failure short-circuits the mutation with accepted:false and diff prefixed 'REJECTED: verification failed — {reason}'"
    - "savePromptVersion is never called for a verification-rejected blueprint (transitive: it is only reached via the accepted branch, which is only reachable after verification passes)"
    - "The existing hybrid-weighted acceptance logic (lines 282-296) is unchanged — it only runs when verification passed, forming an AND-gate on top of the new verification gate"
    - "A new test asserts: a mutation producing a blueprint with an empty systemPrompt is rejected, the rejected EvolutionEntry is appended with accepted=false and a 'REJECTED: verification failed' diff, and neither runAllBenchmarks nor savePromptVersion is invoked for that mutation"
    - "A new unit test file tests/self-improve/blueprint-verifier.test.ts covers each rejection criterion plus a happy-path accept"
    - "npm run typecheck exits 0"
    - "npm test exits 0 (preserves the baseline; +8 new tests — 7 in blueprint-verifier + 1 in optimizer-runner)"
    - "npm run lint exits 0"
  artifacts:
    - path: "src/self-improve/blueprint-verifier.ts"
      provides: "verifyBlueprint(blueprint) + VerificationResult type; pure deterministic verification"
      contains: "verifyBlueprint"
    - path: "src/self-improve/optimizer-runner.ts"
      provides: "Verifier gate inserted BEFORE registry.register + benchmarks; rejected evolution entry on verification failure"
      contains: "verifyBlueprint"
    - path: "tests/self-improve/blueprint-verifier.test.ts"
      provides: "7 unit tests: happy-path, schema-invalid, empty-prompt, too-long-prompt, empty-tools, disallowed-tool, empty-name"
      contains: "verifyBlueprint"
    - path: "tests/self-improve/optimizer-runner.test.ts"
      provides: "New test: verification failure rejects the mutation without running benchmarks or savePromptVersion"
      contains: "verification failed"
  key_links:
    - from: "src/self-improve/optimizer-runner.ts (mutation test loop, ~line 190)"
      to: "src/self-improve/blueprint-verifier.ts (verifyBlueprint)"
      via: "synchronous call; failure continues to next mutation"
      pattern: "verifyBlueprint"
    - from: "src/self-improve/optimizer-runner.ts (savePromptVersion gate, line ~304)"
      to: "blueprint-verifier acceptance"
      via: "transitive: savePromptVersion is only reached via the accepted branch, which is only reachable if verification passed"
      pattern: "savePromptVersion"
---

<objective>
HIGH-05: Add a blueprint verification gate to `src/self-improve/optimizer-runner.ts` so no unverified blueprint ever reaches `registry.register()`, `savePromptVersion()`, or the benchmark runner. Today `mutation.apply()` produces a `mutatedBlueprint` that is immediately written into the registry (line 195), run through benchmarks (lines 204-255), and — if the hybrid-weighted score beats baseline — persisted as a new versioned prompt file via `savePromptVersion()` (line 304). There is NO gate that rejects blueprints whose `systemPrompt` is empty, whose tools list is malformed, or that otherwise fail the `AgentBlueprintSchema`. A poisoned mutation (LLM returning `systemPrompt: ""` or `tools: []`) would end up persisted as `{name}.v{N}.md` and loaded on the next run, silently degrading the agent team.

Purpose: Per REQUIREMENTS.md HIGH-05 success criterion #5: "`src/self-improve/optimizer-runner.ts` rejects unverified blueprints — only blueprints that pass the verifier are written to `.autonomous-dev/agents/{name}.v{N}.md`." The fix is a pure-function verifier (`src/self-improve/blueprint-verifier.ts`) that runs synchronously between `mutation.apply()` and `registry.register()`. Verification failure short-circuits the mutation: a rejected `EvolutionEntry` is appended, and the run moves to the next mutation. No benchmark cost is incurred, no prompt file is written.

Output: One new file (`src/self-improve/blueprint-verifier.ts`), one edit to `src/self-improve/optimizer-runner.ts` inserting the gate, and two test additions (new `tests/self-improve/blueprint-verifier.test.ts` plus one new case in `tests/self-improve/optimizer-runner.test.ts`).
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/REQUIREMENTS.md
@.planning/phases/03-high-priority-runtime-fixes/03-CONTEXT.md
@.claude/skills/typescript/SKILL.md
@src/self-improve/optimizer-runner.ts
@src/self-improve/mutation-engine.ts
@src/self-improve/versioning.ts
@src/state/project-state.ts
@src/types/llm-schemas.ts
@tests/self-improve/optimizer-runner.test.ts

<interfaces>
<!-- Key contracts the executor needs. -->

From src/types/llm-schemas.ts:
```typescript
export const AgentBlueprintSchema = z.object({
  name: z.string(),
  role: z.string(),
  systemPrompt: z.string(),
  tools: z.array(z.string()),
  mcpServers: z.record(z.string(), McpServerConfigSchema).optional(),
  model: z.enum(["opus", "sonnet", "haiku"]).optional(),
  evaluationCriteria: z.array(z.string()),
  version: z.number(),
  score: z.number().optional(),
});
```

From src/state/project-state.ts:
```typescript
export type AgentBlueprint = z.infer<typeof AgentBlueprintSchema>;
```

From src/self-improve/mutation-engine.ts:
```typescript
export interface Mutation {
  description: string;
  type: "agent_prompt" | "tool_config" | "phase_logic" | "quality_threshold";
  targetName: string;
  apply(): AgentBlueprint;    // returns mutated
  rollback(): AgentBlueprint; // returns original
}
```

From src/self-improve/optimizer-runner.ts (the mutation test loop, ~lines 190-325 — the edit surface):
```typescript
for (const mutation of mutations) {
  console.log(`[optimizer] Testing mutation: ${mutation.description}`);

  // Apply mutation
  const mutatedBlueprint = mutation.apply();
  registry.register(mutatedBlueprint);   // ← verification gate inserts BEFORE this line

  // Re-run benchmarks ...
  // ... build EvolutionEntry ...
  // if (accepted) { ... savePromptVersion(config.stateDir, mutatedBlueprint); }
  // else { rollback }
  // register save + saveState + convergence update
}
```

Allowed tools (mirrors SDK + project usage):
```typescript
const ALLOWED_TOOLS = new Set<string>([
  "Read", "Write", "Edit", "Bash", "Glob", "Grep",
  "WebSearch", "WebFetch",
  "Agent", "Task",
]);
// Any tool name starting with "mcp__" is also accepted (MCP tools are dynamic).
```

From tests/self-improve/optimizer-runner.test.ts (existing mocks — reuse):
- `mockRunAllBenchmarks` (async, returns `{ totalScore, results, totalCostUsd }`)
- `mockGenerateMutations` (returns `Mutation[]`)
- `vi.mocked(savePromptVersion)` — imported from `src/self-improve/versioning.js`
- The test file uses `mockAgents: AgentBlueprint[]` as fixtures.
</interfaces>

<notes_for_executor>
1. **Keep the verifier PURE**: no async, no filesystem, no network. Deterministic checks only. That way it's cheap, easy to test, and can't fail open under load.
2. **Verify the SCHEMA first**: `AgentBlueprintSchema.safeParse(candidate)` is the first check. If that fails, return the Zod error message verbatim in `VerificationResult.reason`.
3. **Tool allow-list**: any tool name starting with `mcp__` is accepted (MCP tools are dynamic and named after the server). Anything else must be in the static set.
4. **Position the gate BEFORE `registry.register(mutatedBlueprint)`** — if it sits after, the poisoned blueprint is registered in-memory and would need an explicit rollback.
5. **Rollback on verification failure** is a no-op: the gate runs BEFORE `register`, so the registry still holds the pre-mutation blueprint. Simply `continue`.
6. **Evolution entry diff format**: `"REJECTED: verification failed — {reason}"` lets post-run analysis filter rejected mutations by diff prefix without schema changes.
7. **Convergence update still fires** on rejected mutations — baseline unchanged → stagnation counter ticks; the optimizer won't get stuck in a rejection loop forever.
8. **TypeScript strict**: `VerificationResult` is a discriminated union `{ ok: true; blueprint: AgentBlueprint } | { ok: false; reason: string }` for clean narrowing at the call site.
9. **DO NOT** modify the benchmark error-handling (`evaluationFailed`/`evaluationFailureMessage`). The verifier gate sits OUTSIDE that try/catch.
</notes_for_executor>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Create src/self-improve/blueprint-verifier.ts with verifyBlueprint + VerificationResult</name>
  <files>src/self-improve/blueprint-verifier.ts</files>
  <behavior>
    - `verifyBlueprint(candidate: unknown): VerificationResult` where `VerificationResult = { ok: true; blueprint: AgentBlueprint } | { ok: false; reason: string }`.
    - Step 1: run `AgentBlueprintSchema.safeParse(candidate)`. Fail → `{ ok: false, reason: "schema_invalid: " + zodError.message }`.
    - Step 2: `systemPrompt.length > 50`. Fail → `"system_prompt_too_short: length=N minimum=51"`.
    - Step 3: `systemPrompt.length < 20000`. Fail → `"system_prompt_too_long: length=N maximum=20000"`.
    - Step 4: `tools.length > 0`. Fail → `"tools_empty"`.
    - Step 5: each tool is in `ALLOWED_TOOLS` OR starts with `mcp__`. Fail → `"disallowed_tool: {name}"`.
    - Step 6: `name.trim().length > 0` and `role.trim().length > 0`. Fail → `"empty_name"` / `"empty_role"`.
    - Success: `{ ok: true, blueprint: parsed.data }`.
  </behavior>
  <action>
Create `src/self-improve/blueprint-verifier.ts`:

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

/**
 * Static allow-list of tools permitted in a verified blueprint. Any tool whose
 * name starts with `mcp__` is also accepted (MCP tools are dynamic and named
 * after the MCP server). Extend this list when the project adopts a new SDK
 * tool.
 */
const ALLOWED_TOOLS = new Set<string>([
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "Agent",
  "Task",
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
  // Step 1 — schema validity
  const parsed = AgentBlueprintSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, reason: `schema_invalid: ${parsed.error.message}` };
  }
  const blueprint: AgentBlueprint = parsed.data;

  // Step 2 — prompt lower bound
  if (blueprint.systemPrompt.length < SYSTEM_PROMPT_MIN_CHARS) {
    return {
      ok: false,
      reason: `system_prompt_too_short: length=${blueprint.systemPrompt.length} minimum=${SYSTEM_PROMPT_MIN_CHARS}`,
    };
  }

  // Step 3 — prompt upper bound
  if (blueprint.systemPrompt.length > SYSTEM_PROMPT_MAX_CHARS) {
    return {
      ok: false,
      reason: `system_prompt_too_long: length=${blueprint.systemPrompt.length} maximum=${SYSTEM_PROMPT_MAX_CHARS}`,
    };
  }

  // Step 4 — tools non-empty
  if (blueprint.tools.length === 0) {
    return { ok: false, reason: "tools_empty" };
  }

  // Step 5 — every tool allowed
  for (const tool of blueprint.tools) {
    if (!isAllowedTool(tool)) {
      return { ok: false, reason: `disallowed_tool: ${tool}` };
    }
  }

  // Step 6 — name and role non-empty
  if (blueprint.name.trim().length === 0) {
    return { ok: false, reason: "empty_name" };
  }
  if (blueprint.role.trim().length === 0) {
    return { ok: false, reason: "empty_role" };
  }

  return { ok: true, blueprint };
}

// Exposed for tests that need to assert bounds without duplicating literals.
export const _TEST_EXPORTS = {
  ALLOWED_TOOLS,
  SYSTEM_PROMPT_MIN_CHARS,
  SYSTEM_PROMPT_MAX_CHARS,
};
```

**Self-check:**
- `grep -c "export function verifyBlueprint" src/self-improve/blueprint-verifier.ts` returns 1.
- `grep -c "AgentBlueprintSchema" src/self-improve/blueprint-verifier.ts` returns 2 (import + usage).
- No async, no I/O (no `await`, no `import.*node:fs`, no `import.*node:child_process`).
  </action>
  <verify>
    <automated>npm run typecheck &amp;&amp; grep -c "export function verifyBlueprint" src/self-improve/blueprint-verifier.ts | awk '$1 == 1 { exit 0 } { exit 1 }' &amp;&amp; test $(grep -cE "^\s*(await |import.*node:fs|import.*node:child_process)" src/self-improve/blueprint-verifier.ts) -eq 0</automated>
  </verify>
  <done>
- `src/self-improve/blueprint-verifier.ts` exists.
- `verifyBlueprint` and `VerificationResult` exported.
- Module is pure (no async, no I/O imports).
- `npm run typecheck` exits 0.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Wire verifyBlueprint as a gate in optimizer-runner.ts BEFORE registry.register</name>
  <files>src/self-improve/optimizer-runner.ts</files>
  <behavior>
    - Inside the mutation loop, immediately AFTER `const mutatedBlueprint = mutation.apply();` and BEFORE `registry.register(mutatedBlueprint);`, call `verifyBlueprint(mutatedBlueprint)`.
    - On `{ ok: false }`:
      - Do NOT call `registry.register`.
      - Do NOT enter the benchmark try/catch block.
      - Do NOT call `savePromptVersion`.
      - Append an `EvolutionEntry` with `accepted: false`, `diff: "REJECTED: verification failed — {reason}"`, `scoreBefore: currentState.baselineScore`, `scoreAfter: currentState.baselineScore` (unchanged).
      - `console.warn("[optimizer] Rejecting mutation \"{description}\" — verification failed: {reason}")`.
      - Update convergence with unchanged baseline (stagnation counter increments).
      - `continue` to the next mutation.
    - On `{ ok: true }`: proceed with the existing flow unchanged.
  </behavior>
  <action>
**Edit 1 — Add the import near the other self-improve imports (around line 22):**

Before:
```ts
import { savePromptVersion } from "./versioning.js";
import { runInWorktreeSandbox } from "./sandbox.js";
import type { OptimizerOptions } from "./optimizer.js";
```

After:
```ts
import { savePromptVersion } from "./versioning.js";
import { runInWorktreeSandbox } from "./sandbox.js";
import { verifyBlueprint } from "./blueprint-verifier.js";
import type { OptimizerOptions } from "./optimizer.js";
```

**Edit 2 — Insert the gate inside the `for (const mutation of mutations)` loop, immediately after `const mutatedBlueprint = mutation.apply();`** (currently around line 194):

Before:
```ts
    for (const mutation of mutations) {
      console.log(`[optimizer] Testing mutation: ${mutation.description}`);

      // Apply mutation
      const mutatedBlueprint = mutation.apply();
      registry.register(mutatedBlueprint);

      // Re-run benchmarks (optionally inside an isolated worktree)
      let newScore = 0;
```

After:
```ts
    for (const mutation of mutations) {
      console.log(`[optimizer] Testing mutation: ${mutation.description}`);

      // Apply mutation
      const mutatedBlueprint = mutation.apply();

      // HIGH-05 — Blueprint verification gate. Before we register the
      // candidate and spend benchmark cost, check it passes deterministic
      // verification (schema, prompt length bounds, tool allow-list, non-empty
      // name/role). A rejected mutation is recorded in the evolution log with
      // `accepted: false` and a `REJECTED: verification failed — ...` diff
      // prefix, so post-run forensics can see WHY it was dropped.
      const verification = verifyBlueprint(mutatedBlueprint);
      if (!verification.ok) {
        console.warn(
          `[optimizer] Rejecting mutation "${mutation.description}" — verification failed: ${verification.reason}`,
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
        // registry was NOT mutated (we returned before register), so no
        // rollback is required — the registry still holds the pre-mutation
        // blueprint. Persist state + tick convergence and move on.
        saveState(config.stateDir, currentState);
        convergenceState = updateConvergence(
          convergenceState,
          currentState.baselineScore,
          convergenceConfig,
        );
        continue;
      }

      registry.register(mutatedBlueprint);

      // Re-run benchmarks (optionally inside an isolated worktree)
      let newScore = 0;
```

**Self-check:**
- `grep -c "verifyBlueprint" src/self-improve/optimizer-runner.ts` returns ≥ 2 (import + call site).
- The gate appears BEFORE `registry.register(mutatedBlueprint)` in line order.
- `savePromptVersion(config.stateDir, mutatedBlueprint)` (around line 304) is unchanged.
- `npm run typecheck` exits 0.
  </action>
  <verify>
    <automated>npm run typecheck &amp;&amp; grep -c "verifyBlueprint" src/self-improve/optimizer-runner.ts | awk '$1 >= 2 { exit 0 } { exit 1 }' &amp;&amp; grep -n "verifyBlueprint(mutatedBlueprint)" src/self-improve/optimizer-runner.ts | head -1 | awk -F: '{v=$1} END{exit !(v+0 > 0)}'</automated>
  </verify>
  <done>
- Import added; verifier gate inserted BEFORE `registry.register`.
- Rejected path builds an `EvolutionEntry`, appends to `currentState.evolution`, persists state, updates convergence, `continue`s.
- `savePromptVersion` call untouched.
- `npm run typecheck` exits 0.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Create tests/self-improve/blueprint-verifier.test.ts with 7 cases</name>
  <files>tests/self-improve/blueprint-verifier.test.ts</files>
  <behavior>
    - Test 1 (`'accepts a valid blueprint'`): A fully-formed blueprint passes; result is `{ ok: true, blueprint }`.
    - Test 2 (`'rejects when schema validation fails'`): candidate missing required field (`name`) → `{ ok: false, reason: /^schema_invalid:/ }`.
    - Test 3 (`'rejects when systemPrompt is too short'`): 10-char prompt → `{ ok: false, reason: /system_prompt_too_short/ }`.
    - Test 4 (`'rejects when systemPrompt is too long'`): 20_001-char prompt → `{ ok: false, reason: /system_prompt_too_long/ }`.
    - Test 5 (`'rejects when tools array is empty'`): `tools: []` → `{ ok: false, reason: "tools_empty" }`.
    - Test 6 (`'rejects disallowed tool names'`): `tools: ["Read", "EvilTool"]` → `{ ok: false, reason: "disallowed_tool: EvilTool" }`.
    - Test 7 (`'accepts mcp__-prefixed tool names'`): `tools: ["mcp__playwright__navigate", "Read"]` → `{ ok: true }`.
    - Bonus Test 8 (`'rejects when name is whitespace-only'`): `name: "   "` → `{ ok: false, reason: "empty_name" }`.
  </behavior>
  <action>
Create `tests/self-improve/blueprint-verifier.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { verifyBlueprint } from "../../src/self-improve/blueprint-verifier.js";
import type { AgentBlueprint } from "../../src/state/project-state.js";

const VALID_PROMPT = "You are an expert TypeScript developer. " +
  "Implement tasks carefully, run tests, and commit your work.";
// ^ 99 chars; well above the 51 minimum

function makeBlueprint(overrides: Partial<AgentBlueprint> = {}): AgentBlueprint {
  return {
    name: "test-agent",
    role: "test role",
    systemPrompt: VALID_PROMPT,
    tools: ["Read", "Write"],
    evaluationCriteria: ["correctness"],
    version: 1,
    ...overrides,
  };
}

describe("verifyBlueprint", () => {
  it("accepts a valid blueprint", () => {
    const result = verifyBlueprint(makeBlueprint());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blueprint.name).toBe("test-agent");
    }
  });

  it("rejects when schema validation fails (missing required field)", () => {
    // Omit the `name` field — the Zod schema rejects.
    const { name, ...rest } = makeBlueprint();
    void name;
    const result = verifyBlueprint(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/^schema_invalid:/);
    }
  });

  it("rejects when systemPrompt is too short", () => {
    const result = verifyBlueprint(makeBlueprint({ systemPrompt: "hi" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/system_prompt_too_short/);
    }
  });

  it("rejects when systemPrompt exceeds the 20_000-char upper bound", () => {
    const result = verifyBlueprint(
      makeBlueprint({ systemPrompt: "x".repeat(20_001) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/system_prompt_too_long/);
    }
  });

  it("rejects when tools array is empty", () => {
    const result = verifyBlueprint(makeBlueprint({ tools: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("tools_empty");
    }
  });

  it("rejects disallowed tool names", () => {
    const result = verifyBlueprint(
      makeBlueprint({ tools: ["Read", "EvilTool"] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("disallowed_tool: EvilTool");
    }
  });

  it("accepts mcp__-prefixed tool names", () => {
    const result = verifyBlueprint(
      makeBlueprint({ tools: ["mcp__playwright__navigate", "Read"] }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects when name is whitespace-only", () => {
    const result = verifyBlueprint(makeBlueprint({ name: "   " }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("empty_name");
    }
  });
});
```

**Self-check:**
- File exists with 8 `it(...)` blocks (7 rejection + 1 happy path + 1 mcp tool = 8 total).
- `npm test -- --run tests/self-improve/blueprint-verifier.test.ts` passes.
  </action>
  <verify>
    <automated>npm test -- --run tests/self-improve/blueprint-verifier.test.ts</automated>
  </verify>
  <done>
- `tests/self-improve/blueprint-verifier.test.ts` exists with 8 passing tests.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 4: Extend tests/self-improve/optimizer-runner.test.ts with a verification-rejection integration test</name>
  <files>tests/self-improve/optimizer-runner.test.ts</files>
  <behavior>
    - New test `'rejects mutation with invalid blueprint without running benchmarks or savePromptVersion (HIGH-05)'`:
      1. Mock `generateMutations` to return one mutation whose `apply()` produces a blueprint with `systemPrompt: ""` (verification-rejected by too-short).
      2. Configure `mockRunAllBenchmarks` to count invocations.
      3. Run `runOptimizerImpl`.
      4. Assert `mockRunAllBenchmarks` was called ONCE only (for the baseline, NOT for the rejected mutation).
      5. Assert `savePromptVersion` was called only for baseline agents (once per agent at startup), NOT for the rejected mutation.
      6. Assert `state.evolution` contains exactly one entry with `accepted: false` and `diff` starting with `"REJECTED: verification failed"`.
  </behavior>
  <action>
Inspect the existing `tests/self-improve/optimizer-runner.test.ts` to find where the `describe(...)` block is declared and reuse the existing mock setup.

Append a new `it(...)` block (locate the end of the file's existing test suite):

```ts
it("rejects mutation with invalid blueprint without running benchmarks or savePromptVersion (HIGH-05)", async () => {
  const { runOptimizerImpl } = await import("../../src/self-improve/optimizer-runner.js");
  const { savePromptVersion } = await import("../../src/self-improve/versioning.js");
  const mockedSavePromptVersion = vi.mocked(savePromptVersion);

  benchmarkCallCount = 0;
  benchmarkScores = [0.5]; // baseline only — should never read a second entry

  // Reset counters for this test.
  mockRunAllBenchmarks.mockClear();
  mockedSavePromptVersion.mockClear();

  // One mutation that produces a blueprint with an empty systemPrompt —
  // verification rejects via `system_prompt_too_short`.
  const invalidBlueprint = {
    ...mockAgents[0]!,
    systemPrompt: "", // too short — verifier rejects
  };
  const originalBlueprint = { ...mockAgents[0]! };

  mockGenerateMutations.mockResolvedValueOnce([
    {
      description: "empty-prompt mutation (invalid)",
      type: "agent_prompt",
      targetName: mockAgents[0]!.name,
      apply: () => invalidBlueprint,
      rollback: () => originalBlueprint,
    },
  ]);

  // Provide a state with at least one agent so targetSelection succeeds.
  const state: ProjectState = {
    // reuse whatever `makeInitialStateForOptimizer(...)` helper exists in this
    // test file; if no helper exists, build minimal state inline here matching
    // what the file's earlier tests use.
  } as ProjectState;

  const config = { stateDir: join(tmpdir(), `ads-opt-test-${process.pid}`) } as Config;
  mkdirSync(config.stateDir, { recursive: true });

  try {
    await runOptimizerImpl(state, config, { maxIterations: 1, parallel: false });
  } finally {
    rmSync(config.stateDir, { recursive: true, force: true });
  }

  // Exactly 1 benchmark invocation — the baseline — NOT the rejected mutation.
  expect(mockRunAllBenchmarks).toHaveBeenCalledTimes(1);

  // savePromptVersion was called for initial baseline prompt versions only
  // (once per registered agent at startup). It MUST NOT have been called with
  // the invalid mutation.
  const calledWithInvalid = mockedSavePromptVersion.mock.calls.some(
    ([, bp]) => bp?.systemPrompt === "",
  );
  expect(calledWithInvalid).toBe(false);

  // state.evolution has exactly one rejected entry.
  // (the test harness persists state via mocked saveState; retrieve by reading
  // the last call to the mocked saveState.)
  const lastSaveCall = mockedSaveState.mock.calls[mockedSaveState.mock.calls.length - 1];
  expect(lastSaveCall).toBeDefined();
  const finalState = lastSaveCall![1] as ProjectState;
  expect(finalState.evolution).toHaveLength(1);
  expect(finalState.evolution[0]!.accepted).toBe(false);
  expect(finalState.evolution[0]!.diff).toMatch(/^REJECTED: verification failed/);
});
```

**Pre-edit check**: read `tests/self-improve/optimizer-runner.test.ts` to find:
- The exact name of the state-builder helper (or the inline state shape used in existing tests).
- The `mockedSaveState` identifier (declared near the top of the file).
- The `mockAgents` fixture structure.

Adapt the test body to the actual mock-helper names and the actual `ProjectState` minimum-shape used by existing tests. DO NOT introduce new helpers if the file already has them.

**If the test file uses a shared `beforeEach` that resets `benchmarkCallCount` and `benchmarkScores`, keep those resets inside the new test** (or set them explicitly after the existing `beforeEach`).

**Self-check:**
- The new `it(...)` block is inside the existing `describe("runOptimizerImpl", ...)` or equivalent.
- `grep -c "HIGH-05" tests/self-improve/optimizer-runner.test.ts` returns ≥ 1.
- `grep -c "REJECTED: verification failed" tests/self-improve/optimizer-runner.test.ts` returns ≥ 1.
  </action>
  <verify>
    <automated>npm test -- --run tests/self-improve/optimizer-runner.test.ts</automated>
  </verify>
  <done>
- New test exists and passes.
- `tests/self-improve/optimizer-runner.test.ts` full suite passes.
  </done>
</task>

<task type="auto">
  <name>Task 5: Full test sweep + lint</name>
  <files>(no files modified — verification-only)</files>
  <action>
1. `npm run typecheck`.
2. `npm test` — full suite. Baseline was 811; this plan adds 8 new tests (7 in blueprint-verifier + 1 in optimizer-runner) so total ≥ 819 when run alone. When merged with Plans 01, 02, 03, 04, 06 the total will be higher.
3. `npm run lint`.
4. Record for SUMMARY: the exact set of reasons that can be returned by `verifyBlueprint`, and the grep counts for `verifyBlueprint` in `src/self-improve/`.
  </action>
  <verify>
    <automated>npm run typecheck &amp;&amp; npm test &amp;&amp; npm run lint</automated>
  </verify>
  <done>
- `npm run typecheck` exits 0.
- `npm test` exits 0; +8 tests pass.
- `npm run lint` exits 0.
- SUMMARY enumerates every VerificationResult rejection reason and confirms no poisoned blueprint can reach `savePromptVersion`.
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| `mutation.apply()` output → registry | Untrusted (LLM-mutated prompts/tools); Zod + allow-list enforced |
| Verified blueprint → disk (`savePromptVersion`) | Internal; writes to `.autonomous-dev/agents/{name}.v{N}.md` gated by accept |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-03-05-01 | Tampering | Poisoned blueprint (empty prompt, malicious tool) persisted across runs | mitigate | `verifyBlueprint` rejects before `registry.register` and `savePromptVersion`; rejected mutations recorded in evolution log with `REJECTED:` prefix. |
| T-03-05-02 | Elevation of Privilege | Tool allow-list bypass via non-`mcp__` prefix | mitigate | Static `ALLOWED_TOOLS` set + strict `startsWith("mcp__")` check; no wildcard match. |
| T-03-05-03 | Denial of Service | Very large prompt (>20KB) causing SDK / cost explosion | mitigate | Upper bound = 20_000 chars. |
| T-03-05-04 | Tampering | Verifier bypass via truthy `_TEST_EXPORTS` mutation | accept | Non-production; exported only for test constant access, not for behavior override. |
</threat_model>

<verification>
End-to-end checks for this plan:
- `grep -c "verifyBlueprint" src/self-improve/optimizer-runner.ts` ≥ 2
- `grep -nE "verifyBlueprint\(mutatedBlueprint\)|registry\.register\(mutatedBlueprint\);" src/self-improve/optimizer-runner.ts` — first match is on a LOWER line number than the second (gate precedes register)
- `tests/self-improve/blueprint-verifier.test.ts` has ≥ 7 `it(...)` blocks
- `tests/self-improve/optimizer-runner.test.ts` contains the new HIGH-05 test
- `npm run typecheck && npm test && npm run lint` all green
</verification>

<success_criteria>
- HIGH-05 acceptance criterion #5 holds: unverified blueprints never reach `registry.register`, `runAllBenchmarks`, or `savePromptVersion`.
- Rejected mutations are observable in `state.evolution[]` with `accepted: false` and a `REJECTED: verification failed — {reason}` diff.
- +8 tests pass; no existing test regresses.
</success_criteria>

<output>
After completion, create `.planning/phases/03-high-priority-runtime-fixes/03-05-SUMMARY.md` with:
- The exact content of `src/self-improve/blueprint-verifier.ts` (new file).
- The insertion point + body of the gate in `src/self-improve/optimizer-runner.ts`.
- The 8 test names across the two test files.
- Confirmation that `savePromptVersion(mutatedBlueprint)` call at line ~304 was not modified.
- Enumeration of all possible `VerificationResult.reason` values.
- Final lint/typecheck/test status.
</output>
