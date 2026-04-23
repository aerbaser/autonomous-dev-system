---
phase: 02-critical-security-backlog-closure
plan: 02
type: execute
wave: 2
depends_on:
  - "01"
files_modified:
  - src/self-improve/mutation-engine.ts
autonomous: true
requirements:
  - SEC-02
must_haves:
  truths:
    - "Every interpolated variable in every prompt string in mutation-engine.ts flows through wrapUserInput"
    - "No raw `${blueprint.name}`, `${blueprint.role}`, `${blueprint.model}`, or `${JSON.stringify(blueprint.tools)}` remains inside a prompt template literal"
    - "The existing wrapUserInput(tag, content) helper from src/utils/shared.ts is the only wrapping mechanism (no re-implementation)"
    - "npm run typecheck is clean after the edit"
    - "npm test is green (mutation-engine tests + baseline)"
  artifacts:
    - path: "src/self-improve/mutation-engine.ts"
      provides: "Prompt-injection-hardened mutation prompts for all four mutation types"
      contains: "wrapUserInput"
  key_links:
    - from: "src/self-improve/mutation-engine.ts"
      to: "src/utils/shared.ts#wrapUserInput"
      via: "ESM import (already present) — expanded coverage"
      pattern: "wrapUserInput"
    - from: "src/self-improve/mutation-engine.ts"
      to: "prompt template literals feeding query()"
      via: "each `${expr}` inside a prompt string wrapped in wrapUserInput"
      pattern: "wrapUserInput\\(\""
---

<objective>
SEC-02: Apply `wrapUserInput(tag, content)` to every interpolated variable in every prompt template literal in `src/self-improve/mutation-engine.ts`. Today only 8 interpolations are wrapped (the long strings: `systemPrompt`, `benchmarkSummary`, `recentHistory`). The short inline identifiers — `blueprint.name`, `blueprint.role`, `blueprint.model`, and `JSON.stringify(blueprint.tools)` — are currently interpolated **raw** inside the prompt headers (lines 157, 233–234, 311–312). Those raw interpolations are the exact gap `CON-data-wrap-user-input` calls out.

Purpose: The mutation engine takes LLM-authored blueprint values (agent name, role text, tool list, etc.) and feeds them back into another `query()` prompt to *self-improve*. Without `wrapUserInput` delimiters, an attacker controlling one of those fields can inject follow-on instructions that alter the Meta-Optimizer's behavior (prompt injection into the self-improvement loop is particularly nasty because the output gets *written to disk* as a new blueprint version). Wrapping with XML delimiters is the project-wide rule (DEC-014); this plan closes the one audited gap.

Output: `mutation-engine.ts` where every `${expr}` inside a prompt-string template literal is either a static/local safe number OR wrapped via `wrapUserInput("<tag>", String(value))`.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/REQUIREMENTS.md
@.planning/phases/02-critical-security-backlog-closure/02-CONTEXT.md
@src/self-improve/mutation-engine.ts
@src/utils/shared.ts
@.claude/skills/typescript/SKILL.md

<interfaces>
<!-- Extracted helpers and current import — already in place, do NOT duplicate. -->

From src/utils/shared.ts:
```typescript
/** Wrap user-derived content in XML delimiters to prevent prompt injection. */
export function wrapUserInput(tag: string, content: string): string {
  return `<${tag}>\n${content}\n</${tag}>`;
}
```

From src/self-improve/mutation-engine.ts (existing import at line 6):
```typescript
import { extractFirstJson, isApiRetry, wrapUserInput } from "../utils/shared.js";
```

Interpolated variables currently inside prompt template literals (need wrapping):
- Line 157 (PROMPT_MUTATION prompt): `Agent: ${blueprint.name} (${blueprint.role})`
- Line 233 (TOOL_CONFIG_MUTATION prompt): `Agent: ${blueprint.name} (${blueprint.role})`
- Line 234 (TOOL_CONFIG_MUTATION prompt): `Current tools: ${JSON.stringify(blueprint.tools)}`
- Line 311 (PHASE_LOGIC_MUTATION prompt): `Agent: ${blueprint.name} (${blueprint.role})`
- Line 312 (PHASE_LOGIC_MUTATION prompt): `Current model: ${blueprint.model ?? "default (sonnet)"}`

Interpolations already correctly wrapped (leave alone):
- `wrapUserInput("system_prompt", blueprint.systemPrompt)` — line 160
- `wrapUserInput("benchmark_results", benchmarkSummary)` — lines 163, 237, 314
- `wrapUserInput("mutation_history", recentHistory || "No prior mutations")` — lines 166, 240, 317

Interpolations that are NOT inside a prompt template literal and therefore do not need wrapping (they produce user-facing log strings / EvolutionEntry descriptions — no prompt-injection surface):
- Line 203, 281, 361, 413 — `description` field in the returned Mutation object.
</interfaces>

<notes_for_executor>
1. **Scope is tight**: a single file, ~5 specific lines. Do not restructure the module, rename the prompt constants, or refactor the mutation type selection logic.
2. **Tag naming convention**: use short, descriptive, hyphenated lowercase tags per the project's existing usage in this file: `agent_name`, `agent_role`, `agent_tools`, `agent_model`. (Underscore style is already used for `system_prompt` / `benchmark_results` / `mutation_history` in lines 160/163/166; match it.)
3. **Do not collapse two interpolations into one tag**: the `Agent: ${blueprint.name} (${blueprint.role})` line must become two separate wrappers — one for the name, one for the role — so a malicious role string cannot smuggle a forged name.
4. **`JSON.stringify(blueprint.tools)`** is user-derived content (tool list could be mutated by a prior LLM mutation) → wrap the stringified output, not the array.
5. **`blueprint.model ?? "default (sonnet)"`**: wrap the `??` *result* (a string), not the raw `blueprint.model`. The fallback literal `"default (sonnet)"` is safe but wrapping the resolved value is the simplest uniform approach.
6. **TypeScript strict mode (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)** is on — see `.claude/skills/typescript/SKILL.md`. `String()` coercion of `blueprint.model ?? "default (sonnet)"` remains a `string` and is safe.
7. **Do not interleave SEC-05/SEC-06/other edits** here. This plan is SEC-02 only.
</notes_for_executor>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Wrap the 5 raw interpolations in mutation-engine prompts with wrapUserInput</name>
  <files>src/self-improve/mutation-engine.ts</files>
  <action>
Apply these five targeted `Edit` operations to `src/self-improve/mutation-engine.ts`. The `wrapUserInput` function already exists and is already imported on line 6 — no new imports needed.

**Edit 1 — line 157 (inside `generatePromptMutation`, PROMPT_MUTATION prompt):**

Before:
```ts
      prompt: `${PROMPT_MUTATION}

Agent: ${blueprint.name} (${blueprint.role})

Current system prompt:
${wrapUserInput("system_prompt", blueprint.systemPrompt)}
```

After:
```ts
      prompt: `${PROMPT_MUTATION}

Agent: ${wrapUserInput("agent_name", blueprint.name)} (${wrapUserInput("agent_role", blueprint.role)})

Current system prompt:
${wrapUserInput("system_prompt", blueprint.systemPrompt)}
```

**Edit 2 — lines 233–234 (inside `generateToolConfigMutation`, TOOL_CONFIG_MUTATION prompt):**

Before:
```ts
      prompt: `${TOOL_CONFIG_MUTATION}

Agent: ${blueprint.name} (${blueprint.role})
Current tools: ${JSON.stringify(blueprint.tools)}

Recent benchmark results:
```

After:
```ts
      prompt: `${TOOL_CONFIG_MUTATION}

Agent: ${wrapUserInput("agent_name", blueprint.name)} (${wrapUserInput("agent_role", blueprint.role)})
Current tools: ${wrapUserInput("agent_tools", JSON.stringify(blueprint.tools))}

Recent benchmark results:
```

**Edit 3 — lines 311–312 (inside `generatePhaseLogicMutation`, PHASE_LOGIC_MUTATION prompt):**

Before:
```ts
      prompt: `${PHASE_LOGIC_MUTATION}

Agent: ${blueprint.name} (${blueprint.role})
Current model: ${blueprint.model ?? "default (sonnet)"}

Recent benchmark results:
```

After:
```ts
      prompt: `${PHASE_LOGIC_MUTATION}

Agent: ${wrapUserInput("agent_name", blueprint.name)} (${wrapUserInput("agent_role", blueprint.role)})
Current model: ${wrapUserInput("agent_model", blueprint.model ?? "default (sonnet)")}

Recent benchmark results:
```

**Self-check after editing**: `grep -n "Agent: \${blueprint" src/self-improve/mutation-engine.ts` must return zero lines. Any remaining raw `${blueprint...}` inside a prompt string literal is a miss.

**Counting**: after this change `grep -c "wrapUserInput" src/self-improve/mutation-engine.ts` should be at least **13** (previous 8 + 5 new: one each for `agent_name` three times, `agent_role` three times, `agent_tools` once, `agent_model` once — total 5 new call sites counted by `grep -c`, which counts lines, but `agent_name` and `agent_role` appear on the same line 3 times so counting varies; the tighter invariant is `grep -n "agent_name\|agent_role\|agent_tools\|agent_model" | wc -l` ≥ 3).
  </action>
  <verify>
    <automated>grep -nE '\$\{blueprint\.(name|role|model|tools|systemPrompt)\}' src/self-improve/mutation-engine.ts | grep -v "description\|wrapUserInput\|targetName\|apply:\|rollback:" ; test $(grep -cE '^\s*(Agent:|Current tools:|Current model:) \$\{blueprint' src/self-improve/mutation-engine.ts) -eq 0 && grep -c 'wrapUserInput("agent_' src/self-improve/mutation-engine.ts</automated>
  </verify>
  <done>
- Zero matches for `Agent: ${blueprint` / `Current tools: ${blueprint` / `Current model: ${blueprint` (all three of those patterns are replaced by `wrapUserInput(...)` calls).
- `grep -c 'wrapUserInput("agent_' src/self-improve/mutation-engine.ts` returns a value ≥ 3 (covers `agent_name`, `agent_role`, `agent_tools`, `agent_model`).
- `grep -c "wrapUserInput" src/self-improve/mutation-engine.ts` returns ≥ 13 (was 8; we add five wrapping call sites across 3 prompts, three of which duplicate `agent_name`/`agent_role`).
- The interpolations inside the `description` field (lines 203, 281, 361, 413) are untouched — those are log strings, not prompts.
  </done>
</task>

<task type="auto">
  <name>Task 2: Typecheck + tests to confirm wrapping preserves behavior</name>
  <files>(no files modified — verification-only)</files>
  <action>
1. `npm run typecheck` — confirm strict-mode types are still satisfied. `wrapUserInput` returns `string`, so each wrapped expression is a `string` when interpolated back into the template literal. No type churn expected.
2. `npm test -- --run tests/self-improve/mutation-engine.test.ts` — run the targeted suite. If snapshots compare *exact prompt strings*, update them in this same task and explain in the SUMMARY (this is legitimate: we changed the wire format of prompts deliberately; snapshots should reflect the new wrapped strings).
3. `npm test` — full green baseline.
4. `grep -n "wrapUserInput" src/self-improve/mutation-engine.ts` — record the full list in the SUMMARY for traceability.
  </action>
  <verify>
    <automated>npm run typecheck && npm test -- --run tests/self-improve/mutation-engine.test.ts && npm test</automated>
  </verify>
  <done>
- `npm run typecheck` exits 0.
- `tests/self-improve/mutation-engine.test.ts` passes (with snapshot updates disclosed if any).
- Full `npm test` is green.
- SUMMARY lists the exact set of `wrapUserInput` call sites in the file post-edit.
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| LLM-authored `AgentBlueprint` → Meta-Optimizer prompt | A prior mutation can set `blueprint.name`, `blueprint.role`, `blueprint.model`, or `blueprint.tools` to arbitrary strings. Those strings cross back into a new `query()` prompt. |
| Meta-Optimizer prompt → SDK `query()` | The un-wrapped interpolation point is where an attacker-shaped blueprint value becomes executable meta-instruction. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-02-02-01 | Tampering | blueprint fields injected into Meta-Optimizer prompt | mitigate | XML-delimit every interpolation with `wrapUserInput(tag, content)` per DEC-014. |
| T-02-02-02 | Elevation of Privilege | Prompt-injected "write this to disk as v{N} blueprint" instruction | mitigate | Same wrapping — XML tags fence the payload so the Meta-Optimizer cannot treat it as meta-instruction. Additional defense (tool config parsing) already uses Zod `safeParse`. |
| T-02-02-03 | Information Disclosure | Injected instruction asking Meta-Optimizer to reveal the other blueprints in history | accept | History is already deliberately summarized via `formatHistory`; wrapping the inputs removes the primary exfil path. |
</threat_model>

<verification>
End-to-end phase checks for this plan:
- `grep -c "wrapUserInput" src/self-improve/mutation-engine.ts` ≥ 13 (8 existing + 5 new).
- Zero raw `${blueprint.…}` expressions remain inside any prompt template literal (i.e. inside the string passed as `prompt:` to `query(...)`).
- `npm run typecheck && npm test` green.
</verification>

<success_criteria>
- All 5 previously-raw interpolations in the three prompt template literals are wrapped via `wrapUserInput`.
- No regression in `mutation-engine.test.ts` or the broader suite.
- `CON-data-wrap-user-input` constraint now holds project-wide with no remaining audited gap in this file.
</success_criteria>

<output>
After completion, create `.planning/phases/02-critical-security-backlog-closure/02-02-SUMMARY.md` including:
- The exact before/after diff for the 3 prompt blocks.
- Final count + list of `wrapUserInput` call sites in `mutation-engine.ts`.
- Any test-snapshot updates and why they were required.
</output>
