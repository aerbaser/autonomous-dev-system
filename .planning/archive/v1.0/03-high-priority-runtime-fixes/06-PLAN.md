---
phase: 03-high-priority-runtime-fixes
plan: 06
type: execute
wave: 1
depends_on: []
files_modified:
  - src/types/llm-schemas.ts
  - src/agents/domain-analyzer.ts
  - src/phases/development-runner.ts
  - tests/phases/development-runner.test.ts
autonomous: true
requirements:
  - HIGH-06
must_haves:
  truths:
    - "AgentBlueprintSchema in src/types/llm-schemas.ts has a new optional field `keywords: z.array(z.string()).optional()` so domain-generated agents can declare matching keywords without breaking existing blueprints (which omit the field)"
    - "src/agents/domain-analyzer.ts populates `keywords` for every domain-generated blueprint — derived from the agent's role, specialization, and the schema field's prompt instruction"
    - "src/phases/development-runner.ts uses a NEW matching function `matchDomainAgentForTask(task, domainAgents): AgentBlueprint | undefined` that scores candidates by: (a) exact name/role substring match in task.title (existing behavior — preserved), (b) any blueprint.keywords[i] substring match in task.title OR task.description, (c) any task.tags[i] match against blueprint.keywords; the highest-scoring agent wins; ties broken by registration order"
    - "When no domain agent matches, the existing generic `dev-{taskIdPrefix}` fallback runs unchanged"
    - "A new test asserts: a task titled 'T-026 Chat service with RAG' WITH no domain field but with description containing 'RAG' selects an agent whose keywords include 'rag' (the canonical example from PRODUCT.md §4 'Known weakness')"
    - "Existing test 'tests/integration/domain-agents.test.ts' continues to pass — no regression in name/role substring matching"
    - "npm run typecheck exits 0"
    - "npm test exits 0 (preserves baseline; +2 new tests)"
    - "npm run lint exits 0"
  artifacts:
    - path: "src/types/llm-schemas.ts"
      provides: "AgentBlueprintSchema extended with optional `keywords` field"
      contains: "keywords"
    - path: "src/agents/domain-analyzer.ts"
      provides: "generateDomainAgents emits `keywords[]` for every blueprint by extending the JSON schema and prompt instruction"
      contains: "keywords"
    - path: "src/phases/development-runner.ts"
      provides: "Exported helper matchDomainAgentForTask + replacement of the inline find() at lines 605-609 with a call to it"
      contains: "matchDomainAgentForTask"
    - path: "tests/phases/development-runner.test.ts"
      provides: "Two new tests: (a) keyword match wins when name/role substring fails, (b) ties broken by registration order"
      contains: "matchDomainAgentForTask"
  key_links:
    - from: "src/types/llm-schemas.ts (AgentBlueprintSchema)"
      to: "src/state/project-state.ts (AgentBlueprint type — z.infer)"
      via: "Zod inference; the new optional field flows through automatically"
      pattern: "keywords"
    - from: "src/agents/domain-analyzer.ts (generateDomainAgents)"
      to: "src/types/llm-schemas.ts (AgentBlueprintSchema)"
      via: "JSON schema fed to query() outputFormat — adds keywords field"
      pattern: "keywords"
    - from: "src/phases/development-runner.ts (buildBatchAgents, around line 600)"
      to: "matchDomainAgentForTask helper"
      via: "replaces inline `domainAgents.find(...)` call"
      pattern: "matchDomainAgentForTask"
---

<objective>
HIGH-06: Wire keyword-based task↔agent matching into `src/phases/development-runner.ts` so domain-specialized agents are actually selected for matching tasks. Today (lines 604-609) matching is `titleLower.includes(bp.name.toLowerCase()) || titleLower.includes(bp.role.toLowerCase())` — a strict substring of the agent's *name* or *role* in the task *title*. This is fragile: a task titled `"T-026 Chat service with RAG"` will NEVER match an agent named `llm-integration-specialist` (no substring overlap), even though the agent is the obvious right choice. PRODUCT.md §4 explicitly calls this out as the "Known weakness." The fix is documented in `tasks-plans/tasks.md` (item 3 "Wire domain agents into task assignment via keywords[]").

Purpose: Per REQUIREMENTS.md HIGH-06 success criterion #6: "The development runner picks domain-specialized agents over base agents when a task description contains domain keywords matching an agent's blueprint." The fix has three coordinated edits:
  1. Schema: add an optional `keywords: string[]` field to `AgentBlueprintSchema`. Optional so existing in-flight registries (which lack the field) continue to load via `safeParse`.
  2. Producer: extend `domain-analyzer.ts` so the `generateDomainAgents` LLM call emits `keywords[]` populated for every domain agent.
  3. Consumer: replace the inline `find()` in `development-runner.ts` with a `matchDomainAgentForTask` helper that scores candidates across name/role substring (preserved), keyword∩title, keyword∩description, and keyword∩task.tags. Highest score wins; ties broken by registration order.

Output: One Zod schema extension, one prompt/JSON-schema extension in domain-analyzer, one helper + call-site change in development-runner, and two new tests.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/REQUIREMENTS.md
@.planning/phases/03-high-priority-runtime-fixes/03-CONTEXT.md
@.claude/skills/typescript/SKILL.md
@src/types/llm-schemas.ts
@src/agents/domain-analyzer.ts
@src/phases/development-runner.ts
@src/state/project-state.ts
@tests/phases/development-runner.test.ts
@tests/integration/domain-agents.test.ts

<interfaces>
<!-- Key contracts the executor needs. -->

From src/types/llm-schemas.ts (current AgentBlueprintSchema, lines 292-302 — the schema to extend):
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

After this plan:
```typescript
export const AgentBlueprintSchema = z.object({
  // ... existing fields ...
  score: z.number().optional(),
  // HIGH-06: domain keywords for task↔agent matching. Optional so older
  // persisted blueprints (which omit the field) load cleanly via safeParse.
  keywords: z.array(z.string()).optional(),
});
```

From src/state/project-state.ts:
```typescript
export type AgentBlueprint = z.infer<typeof AgentBlueprintSchema>;
// `keywords?: string[]` flows through automatically via z.infer.
```

From src/state/project-state.ts (Task type — already has tags):
```typescript
export const TaskStateSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum([...]),
  // ...
  domain: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
```

From src/phases/development-runner.ts (the matching site — current code, lines ~595-642):
```typescript
// Collect domain-specific agents from registry (everything that isn't a base agent)
const domainAgents = registry
  .getAll()
  .filter((bp) => !BASE_AGENT_NAMES.has(bp.name));

// Create a dedicated agent per task in this batch
for (const task of batch) {
  // Check if a domain agent matches this task by title keywords
  const titleLower = task.title.toLowerCase();
  const matchingDomain = domainAgents.find(
    (bp) =>
      titleLower.includes(bp.name.toLowerCase()) ||
      titleLower.includes(bp.role.toLowerCase())
  );

  // ... rest of the loop body builds the agent definition based on matchingDomain ...
}
```

From src/agents/domain-analyzer.ts (the generator to extend) — read this file before editing to find:
- The exact name of the JSON schema fed to `query({ options: { outputFormat: ... } })` for blueprint generation.
- Where the prompt explains what fields each blueprint must populate.

Add `keywords: { type: "array", items: { type: "string" }, description: "..." }` to the schema's `properties` AND a sentence to the prompt instruction explaining the field semantics. The schema MUST mark `keywords` as required in the `outputFormat` so the LLM is forced to emit it (even if our Zod schema marks it optional for backward compat with persisted older blueprints).

From tests/phases/development-runner.test.ts (existing pattern — `describe("Development Runner", ...)`):
- Tests already import `runDevelopment`, `harvestReceipts`, `parseTaskResults`, etc.
- Several existing tests construct fake `AgentBlueprint` registries by writing to `<TEST_DIR>/.autonomous-dev/agents/index.json` directly (look for that pattern).

For the new tests we need to expose `matchDomainAgentForTask` from `development-runner.ts` so unit tests can call it directly without mocking the entire runner. Add `export` to the new helper.
</interfaces>

<notes_for_executor>
1. **Backward compat is non-negotiable.** Older `.autonomous-dev/agents/index.json` files (already on operators' disks) lack the `keywords` field. Marking the Zod field `.optional()` lets `safeParse` accept those persisted blueprints. The matching helper must guard against `bp.keywords === undefined`.
2. **The LLM-emitted JSON schema** in `domain-analyzer.ts` should mark `keywords` as REQUIRED so newly-generated blueprints always have it. (Required at the LLM-output boundary, optional at the Zod boundary — that's intentional.)
3. **Matching algorithm — keep it simple and deterministic**:
   - score = 0
   - +3 if `task.title.toLowerCase().includes(bp.name.toLowerCase())` (preserve existing behavior, weight high)
   - +2 if `task.title.toLowerCase().includes(bp.role.toLowerCase())` (existing, weight high)
   - +1 for each keyword `kw` in `bp.keywords` that satisfies `task.title.toLowerCase().includes(kw.toLowerCase())` OR `task.description.toLowerCase().includes(kw.toLowerCase())`
   - +1 for each `tag` in `task.tags` that satisfies `bp.keywords.some(kw => kw.toLowerCase() === tag.toLowerCase())`
   - The highest-scoring agent wins. Score-zero candidates are NOT returned (no false positives).
   - Ties: pick the FIRST agent in `domainAgents.find` order (which mirrors registry registration order).
4. **Do NOT lowercase `bp.keywords` at write time** — keywords stay as-emitted by the LLM (could be capitalized). All comparisons lowercase both sides at compare time.
5. **Helper signature**: `export function matchDomainAgentForTask(task: Task, domainAgents: AgentBlueprint[]): AgentBlueprint | undefined`. Pure function, easy to unit-test.
6. **TypeScript strict** — `noUncheckedIndexedAccess`: `task.tags?.[i]` returns `string | undefined`; narrow with `??`/optional chaining.
7. **The existing test `tests/integration/domain-agents.test.ts`** validates the name/role substring matching behavior. Run it to confirm no regression — your scoring algorithm preserves the score-3/score-2 boost for those cases, so existing matches still win.
8. **Do NOT change the prompt-cache key shape** in `buildSharedTaskContext` or anywhere downstream — keywords don't appear in the prompt itself, only in the matching decision.
</notes_for_executor>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Extend AgentBlueprintSchema with optional `keywords` and update domain-analyzer to emit it</name>
  <files>src/types/llm-schemas.ts, src/agents/domain-analyzer.ts</files>
  <behavior>
    - `AgentBlueprintSchema` accepts a new OPTIONAL `keywords: z.array(z.string()).optional()` field; existing persisted blueprints without the field still load via `safeParse`.
    - `src/agents/domain-analyzer.ts`'s `generateDomainAgents` JSON outputFormat lists `keywords` as a REQUIRED field (so newly-generated blueprints always include it) and the prompt explains the field's semantics.
  </behavior>
  <action>
**Edit 1 — `src/types/llm-schemas.ts`, AgentBlueprintSchema (around line 292-302):**

Before:
```ts
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

After:
```ts
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
  // HIGH-06: domain keywords for task↔agent matching in development-runner.
  // Optional at the Zod boundary so older persisted registries (which lack
  // the field) still load via safeParse. The LLM-emitting schema in
  // `src/agents/domain-analyzer.ts` marks the field as REQUIRED so all
  // newly-generated blueprints carry it.
  keywords: z.array(z.string()).optional(),
});
```

**Edit 2 — `src/agents/domain-analyzer.ts`** — first READ the file to locate:
  - The `outputFormat` JSON schema for `generateDomainAgents`.
  - The prompt text that lists each field the LLM should produce.

Then apply two edits inside `generateDomainAgents`:

(a) Add `keywords` to the JSON schema's `properties` object AND add `"keywords"` to its `required` array. Approximate edit (adapt to actual file content):

Before (the relevant `properties` block):
```ts
properties: {
  name: { type: "string" },
  role: { type: "string" },
  systemPrompt: { type: "string" },
  tools: { type: "array", items: { type: "string" } },
  evaluationCriteria: { type: "array", items: { type: "string" } },
  // ...
},
required: ["name", "role", "systemPrompt", "tools", "evaluationCriteria"],
```

After:
```ts
properties: {
  name: { type: "string" },
  role: { type: "string" },
  systemPrompt: { type: "string" },
  tools: { type: "array", items: { type: "string" } },
  evaluationCriteria: { type: "array", items: { type: "string" } },
  // HIGH-06: keywords for task matching. Lowercase, hyphen-separated, 3-7 entries.
  // Examples: ["rag", "vector-db", "embeddings"], ["payments", "stripe", "webhooks"].
  keywords: {
    type: "array",
    items: { type: "string" },
    description: "Lowercase domain keywords (3-7) used to match this agent against task titles, descriptions, and tags. Examples: ['rag', 'embeddings', 'vector-db'] for an LLM/RAG specialist; ['payments', 'stripe', 'webhooks'] for a payments specialist. Avoid generic words ('developer', 'agent', 'helper').",
  },
  // ...
},
required: ["name", "role", "systemPrompt", "tools", "evaluationCriteria", "keywords"],
```

(b) Append a sentence to the prompt instructing the LLM to populate `keywords`. Find the existing prompt section that enumerates fields ("For each agent, produce a JSON object with...") and add:

```
- "keywords": 3-7 lowercase domain keywords used by the development runner to
  match this agent to incoming tasks. Pick concrete domain terms, NOT generic
  words like "developer" or "code". Example for an LLM/RAG specialist:
  ["rag", "embeddings", "vector-db", "llm-integration"]. Example for a
  payments specialist: ["payments", "stripe", "webhook", "billing"].
```

(If the prompt is built via a template literal, insert the sentence in a position parallel to the existing field descriptions.)

**Self-check:**
- `grep -n "keywords:" src/types/llm-schemas.ts` returns 1+ matches inside `AgentBlueprintSchema`.
- `grep -n "keywords" src/agents/domain-analyzer.ts` returns 2+ matches (schema + prompt).
- `npm run typecheck` exits 0.
  </action>
  <verify>
    <automated>npm run typecheck &amp;&amp; grep -c "keywords:" src/types/llm-schemas.ts | awk '$1 >= 1 { exit 0 } { exit 1 }' &amp;&amp; grep -c "keywords" src/agents/domain-analyzer.ts | awk '$1 >= 2 { exit 0 } { exit 1 }'</automated>
  </verify>
  <done>
- `AgentBlueprintSchema` has the new optional `keywords` field.
- `generateDomainAgents` JSON schema lists `keywords` as required + prompt text instructs the LLM how to populate it.
- `npm run typecheck` exits 0.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Add matchDomainAgentForTask helper to development-runner.ts and replace inline find()</name>
  <files>src/phases/development-runner.ts</files>
  <behavior>
    - New `export function matchDomainAgentForTask(task: Task, domainAgents: AgentBlueprint[]): AgentBlueprint | undefined` implements the scoring algorithm in `<notes_for_executor>` step 3:
      - +3 if `task.title.toLowerCase().includes(bp.name.toLowerCase())`
      - +2 if `task.title.toLowerCase().includes(bp.role.toLowerCase())`
      - +1 per keyword that hits `task.title` OR `task.description` (case-insensitive substring)
      - +1 per `task.tags[i]` whose lowercase exactly matches a lowercased `bp.keywords[j]`
      - Returns the highest-scoring agent. Score-zero is treated as no match (returns `undefined`). Ties: first in input order wins.
    - The inline `find()` at lines ~605-609 in `buildBatchAgents` is replaced by a call to the new helper.
    - The `Using domain agent: {agentName}` console.log line on the matched-domain branch is preserved.
  </behavior>
  <action>
**Edit 1 — Add the helper near the other exported helpers in `src/phases/development-runner.ts`** (e.g., after `renderSkillBlock` around line 666 OR right above `buildBatchAgents` around line 572 — pick the location that keeps related concerns together):

```ts
/**
 * HIGH-06 — Match a task to its best domain-specialized agent (if any).
 *
 * Scoring (deterministic):
 *   +3 if task.title (case-insensitive) contains the agent's name
 *   +2 if task.title (case-insensitive) contains the agent's role
 *   +1 per agent.keywords[i] that appears (case-insensitive substring) in
 *      task.title OR task.description
 *   +1 per task.tags[j] whose lowercase equals a lowercased agent.keywords[k]
 *
 * Returns the highest-scoring agent. A score of zero is treated as "no match"
 * so we don't accidentally promote a base/generic agent over the dev-{id}
 * fallback. Ties are broken by input order (which mirrors registry
 * registration order — first registered wins).
 *
 * The function is pure and exported so unit tests can call it directly without
 * spinning up the full runner.
 */
export function matchDomainAgentForTask(
  task: Task,
  domainAgents: AgentBlueprint[],
): AgentBlueprint | undefined {
  const titleLower = task.title.toLowerCase();
  const descLower = task.description.toLowerCase();
  const tagSet = new Set(
    (task.tags ?? []).map((t) => t.toLowerCase()),
  );

  let best: AgentBlueprint | undefined;
  let bestScore = 0;

  for (const bp of domainAgents) {
    let score = 0;
    if (titleLower.includes(bp.name.toLowerCase())) score += 3;
    if (titleLower.includes(bp.role.toLowerCase())) score += 2;

    for (const kw of bp.keywords ?? []) {
      const kwLower = kw.toLowerCase();
      if (titleLower.includes(kwLower) || descLower.includes(kwLower)) {
        score += 1;
      }
      if (tagSet.has(kwLower)) score += 1;
    }

    if (score > bestScore) {
      bestScore = score;
      best = bp;
    }
  }

  return bestScore > 0 ? best : undefined;
}
```

**Edit 2 — Replace the inline `find()` in `buildBatchAgents` (currently around lines 603-609) with a call to the helper.**

Before:
```ts
  // Create a dedicated agent per task in this batch
  for (const task of batch) {
    // Check if a domain agent matches this task by title keywords
    const titleLower = task.title.toLowerCase();
    const matchingDomain = domainAgents.find(
      (bp) =>
        titleLower.includes(bp.name.toLowerCase()) ||
        titleLower.includes(bp.role.toLowerCase())
    );
```

After:
```ts
  // Create a dedicated agent per task in this batch
  for (const task of batch) {
    // HIGH-06: keyword-aware matching — scores name/role substring (preserved
    // legacy behavior) PLUS keyword∩title, keyword∩description, and
    // keyword∩task.tags. See `matchDomainAgentForTask` for scoring details.
    const matchingDomain = matchDomainAgentForTask(task, domainAgents);
```

(Remove the now-unused `titleLower` local variable from the inline block; it's still used later in the same function for skill-related logic — verify by reading around lines 610-642 and only delete the local if it's not referenced again. If it is referenced again, just remove the line `const titleLower = task.title.toLowerCase();` only if the helper now provides equivalent semantics — otherwise leave the local declaration.)

**Self-check:**
- `grep -c "export function matchDomainAgentForTask" src/phases/development-runner.ts` returns 1.
- `grep -c "matchDomainAgentForTask(task, domainAgents)" src/phases/development-runner.ts` returns 1 (the call site).
- The pre-existing `domainAgents.find(...)` block referencing `titleLower.includes(bp.name.toLowerCase())` is replaced.
- `npm run typecheck` exits 0.
  </action>
  <verify>
    <automated>npm run typecheck &amp;&amp; grep -c "export function matchDomainAgentForTask" src/phases/development-runner.ts | awk '$1 == 1 { exit 0 } { exit 1 }' &amp;&amp; grep -c "matchDomainAgentForTask(task, domainAgents)" src/phases/development-runner.ts | awk '$1 >= 1 { exit 0 } { exit 1 }'</automated>
  </verify>
  <done>
- Helper is exported and used.
- Inline find() at the call site is gone.
- `npm run typecheck` exits 0.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Add unit tests for matchDomainAgentForTask covering name/role/keyword/tag matching and tie-breaking</name>
  <files>tests/phases/development-runner.test.ts</files>
  <behavior>
    - Test 1 (`'matchDomainAgentForTask: keyword match wins when name/role substring fails (HIGH-06)'`): Two domain agents in the registry: `llm-integration-specialist` (role "RAG Specialist", keywords ["rag", "embeddings", "vector-db"]) and `payments-specialist` (role "Payments Engineer", keywords ["stripe", "billing"]). A task `{ title: "T-026 Chat service with RAG", description: "Build a chat service with RAG and embeddings" }` MUST select `llm-integration-specialist` — even though its `name` and `role` do not appear as substrings in the task title.
    - Test 2 (`'matchDomainAgentForTask: ties broken by input order (HIGH-06)'`): Two agents with identical scoring opportunities (same single matching keyword). The agent that appears FIRST in the input array wins.
    - Test 3 (bonus, `'matchDomainAgentForTask: returns undefined when no agent scores > 0'`): A task with title and description that share no overlap with any blueprint keyword/name/role returns `undefined`.
  </behavior>
  <action>
Append to the existing `describe(...)` block in `tests/phases/development-runner.test.ts` (or create a new sibling `describe("matchDomainAgentForTask", ...)` block — match the file's existing nesting style by inspecting it first).

```ts
import { matchDomainAgentForTask } from "../../src/phases/development-runner.js";
// ^ ADD this import to the file's top-of-file import list (NOT inside the describe).

describe("matchDomainAgentForTask (HIGH-06)", () => {
  const llmAgent: AgentBlueprint = {
    name: "llm-integration-specialist",
    role: "RAG Specialist",
    systemPrompt: "You build retrieval-augmented generation pipelines.",
    tools: ["Read", "Write", "Bash"],
    evaluationCriteria: ["embedding quality"],
    version: 1,
    keywords: ["rag", "embeddings", "vector-db", "llm-integration"],
  };

  const paymentsAgent: AgentBlueprint = {
    name: "payments-specialist",
    role: "Payments Engineer",
    systemPrompt: "You integrate payment providers.",
    tools: ["Read", "Write", "Bash"],
    evaluationCriteria: ["webhook reliability"],
    version: 1,
    keywords: ["stripe", "billing", "webhook"],
  };

  it("keyword match wins when name/role substring fails (HIGH-06)", () => {
    const task: Task = {
      id: "T-026",
      title: "T-026 Chat service with RAG",
      description: "Build a chat service with RAG and embeddings",
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    const matched = matchDomainAgentForTask(task, [paymentsAgent, llmAgent]);
    expect(matched?.name).toBe("llm-integration-specialist");
  });

  it("ties broken by input order (HIGH-06)", () => {
    // Two agents with one matching keyword each — same score = 1.
    const a: AgentBlueprint = {
      ...llmAgent,
      name: "agent-a",
      role: "Specialist A",
      keywords: ["alpha"],
    };
    const b: AgentBlueprint = {
      ...llmAgent,
      name: "agent-b",
      role: "Specialist B",
      keywords: ["alpha"],
    };
    const task: Task = {
      id: "T-100",
      title: "Task: alpha workflow",
      description: "Implement an alpha-mode workflow",
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    // agent-a appears first → wins on tie.
    expect(matchDomainAgentForTask(task, [a, b])?.name).toBe("agent-a");
    // Reverse the input order → agent-b wins.
    expect(matchDomainAgentForTask(task, [b, a])?.name).toBe("agent-b");
  });

  it("returns undefined when no agent scores above zero (HIGH-06)", () => {
    const task: Task = {
      id: "T-200",
      title: "Refactor unrelated CSS variables",
      description: "Update theme tokens in design system",
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    expect(matchDomainAgentForTask(task, [llmAgent, paymentsAgent])).toBeUndefined();
  });
});
```

**Pre-edit check**: open `tests/phases/development-runner.test.ts` and confirm:
- The file already imports `Task` and `AgentBlueprint` types — if not, add the imports.
- The new `describe(...)` block is at the SAME nesting level as the existing `describe("Development Runner", ...)`, NOT nested inside it.
- The `matchDomainAgentForTask` import is added to the file's top-of-file import block, not inside the describe.

**Self-check:**
- `grep -c "matchDomainAgentForTask" tests/phases/development-runner.test.ts` returns ≥ 4 (1 import + 3 call sites).
- `grep -c "HIGH-06" tests/phases/development-runner.test.ts` returns ≥ 3 (one per new test).
- `npm test -- --run tests/phases/development-runner.test.ts` exits 0.
  </action>
  <verify>
    <automated>npm test -- --run tests/phases/development-runner.test.ts</automated>
  </verify>
  <done>
- 3 new tests assert keyword precedence, tie-breaking, and the no-match path.
- Existing tests in the file still pass.
  </done>
</task>

<task type="auto">
  <name>Task 4: Confirm tests/integration/domain-agents.test.ts still passes (no regression)</name>
  <files>(no files modified — verification-only)</files>
  <action>
Run the existing integration suite that exercises domain-agent selection:

```bash
npm test -- --run tests/integration/domain-agents.test.ts
```

This test exercises the legacy name/role substring matching path. Our scoring algorithm preserves +3/+2 for those cases, so existing matches still win. If a test fails, the most likely root cause is that an existing test fixture sets `keywords: undefined` and one of the test's expected matches now requires a non-zero score; in that case, ADD `keywords` to the relevant fixture (the legacy substring-only path is preserved by the +3/+2 boost).
  </action>
  <verify>
    <automated>npm test -- --run tests/integration/domain-agents.test.ts</automated>
  </verify>
  <done>
- `tests/integration/domain-agents.test.ts` continues to pass.
  </done>
</task>

<task type="auto">
  <name>Task 5: Full test sweep + lint</name>
  <files>(no files modified — verification-only)</files>
  <action>
1. `npm run typecheck` — confirm strict-mode types hold across all 4 modified files.
2. `npm test` — full suite. Baseline 811 + 3 new tests = 814 minimum, plus any tests added by other plans in flight.
3. `npm run lint`.
4. For SUMMARY: enumerate the new behavior (+3/+2/+1 scoring), confirm the inline `find()` was replaced, list the 3 new test names.
  </action>
  <verify>
    <automated>npm run typecheck &amp;&amp; npm test &amp;&amp; npm run lint</automated>
  </verify>
  <done>
- `npm run typecheck` exits 0.
- `npm test` exits 0; +3 new tests pass.
- `npm run lint` exits 0.
- SUMMARY documents the scoring algorithm and file diff summary.
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| LLM-emitted blueprint keywords → registry | Untrusted; bounded list size + Zod schema |
| Task title/description (LLM-derived from spec) → matching scorer | Already wrapped via `wrapUserInput` upstream in dev-runner prompts; matching here is read-only string substring |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-03-06-01 | Tampering | LLM emits adversarial keywords (e.g. extremely long string) to dominate matching | accept | Length-bounded by JSON schema + Zod parse cost; matching is O(keywords × tasks) and bounded by registry size (typically < 20 agents). |
| T-03-06-02 | Spoofing | Generic keyword (e.g. "data") matches every task | mitigate | Prompt explicitly instructs LLM to avoid generic words; +3/+2 name/role boost ensures specific matches dominate. |
| T-03-06-03 | Information Disclosure | Keyword leak across projects | accept | Keywords live in per-project `.autonomous-dev/agents/index.json`; not exfiltrated. |
</threat_model>

<verification>
End-to-end checks for this plan:
- `grep -c "keywords:" src/types/llm-schemas.ts` ≥ 1 (inside AgentBlueprintSchema)
- `grep -c "keywords" src/agents/domain-analyzer.ts` ≥ 2 (schema + prompt)
- `grep -c "export function matchDomainAgentForTask" src/phases/development-runner.ts` = 1
- `grep -c "matchDomainAgentForTask(task, domainAgents)" src/phases/development-runner.ts` ≥ 1
- The legacy `domainAgents.find((bp) => titleLower.includes(bp.name.toLowerCase()) || titleLower.includes(bp.role.toLowerCase()))` block is gone
- `tests/integration/domain-agents.test.ts` still passes
- `npm run typecheck && npm test && npm run lint` all green
</verification>

<success_criteria>
- HIGH-06 acceptance criterion #6 holds: a task whose title/description contains domain keywords (without name/role substring overlap) selects the matching domain agent.
- Backward compat preserved: blueprints without `keywords` still load via `safeParse`.
- +3 new tests pass; no existing test regresses.
</success_criteria>

<output>
After completion, create `.planning/phases/03-high-priority-runtime-fixes/03-06-SUMMARY.md` with:
- The exact diff for `AgentBlueprintSchema` extension.
- The exact diff for `domain-analyzer.ts` (schema + prompt).
- The new `matchDomainAgentForTask` helper body and the call-site replacement diff.
- The 3 new test names with one-line descriptions.
- Confirmation that `tests/integration/domain-agents.test.ts` still passes.
- Final lint/typecheck/test status.
</output>
