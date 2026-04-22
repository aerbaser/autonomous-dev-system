---
phase: 02-critical-security-backlog-closure
plan: 02
subsystem: self-improve
tags: [security, prompt-injection, mutation-engine, wrap-user-input, DEC-014, SEC-02]

# Dependency graph
requires:
  - phase: 02-critical-security-backlog-closure
    plan: 01
    provides: Pinned @anthropic-ai/claude-agent-sdk@0.2.90 — stable query() type surface that receives the newly-wrapped prompt strings
provides:
  - Prompt-injection-hardened prompts for all three mutation types (agent_prompt, tool_config, phase_logic)
  - Every interpolated variable in every prompt template literal in src/self-improve/mutation-engine.ts now flows through wrapUserInput
  - CON-data-wrap-user-input constraint audit gap closed for this file
affects:
  - DEC-014 project-wide compliance surface now passes audit for mutation-engine.ts (the single outstanding raw-interpolation site identified in the backlog)
  - Follow-on SEC-* plans (02-03..02-08) remain unaffected — this plan is a single-file edit with zero cross-file coupling

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "XML-delimited prompt interpolation (wrapUserInput) uniformly applied per DEC-014"
    - "Two separate wrappers per `Name (Role)` construct — a malicious role string cannot smuggle a forged name"

key-files:
  created:
    - .planning/phases/02-critical-security-backlog-closure/02-SUMMARY.md
  modified:
    - src/self-improve/mutation-engine.ts

decisions:
  - "Tag naming follows existing underscore convention (agent_name, agent_role, agent_tools, agent_model) to match system_prompt / benchmark_results / mutation_history already present in the file."
  - "For `Agent: \\${name} (\\${role})` each field is wrapped independently rather than concatenated — prevents a forged name inside a role payload from appearing at the XML boundary."
  - "`JSON.stringify(blueprint.tools)` is wrapped (not the array) because the stringified text is what becomes prompt content."
  - "`blueprint.model ?? \"default (sonnet)\"` is wrapped after the coalesce — the resolved string is what reaches the prompt; uniform wrapping also covers the literal fallback for zero cognitive overhead."
  - "Description-field log strings at lines 203, 281, 361, 413 remain raw — they are EvolutionEntry metadata surfaced to the user, not prompt content passed to query(), and wrapping them would leak XML tags into human-readable logs."

# Execution metrics
metrics:
  duration_seconds: 281
  tasks_completed: 2
  files_modified: 1
  completed: 2026-04-22
---

# Phase 02 Plan 02: SEC-02 wrapUserInput in mutation-engine Summary

Hardened the Meta-Optimizer's self-improvement prompts in `src/self-improve/mutation-engine.ts` against prompt injection by wrapping the five remaining raw `${blueprint.…}` interpolations with `wrapUserInput`, closing the CON-data-wrap-user-input gap called out in the Phase 2 security backlog.

## Objective

Apply `wrapUserInput(tag, content)` to every interpolated variable in every prompt template literal in `src/self-improve/mutation-engine.ts`. Only the long-string interpolations (`systemPrompt`, `benchmarkSummary`, `recentHistory`) were wrapped prior to this plan; the short inline identifiers (`blueprint.name`, `blueprint.role`, `blueprint.model`, `JSON.stringify(blueprint.tools)`) were interpolated raw on lines 157, 233–234, 311–312.

## Before/After Diff (3 prompt blocks)

### Block 1 — PROMPT_MUTATION (line 157, `generatePromptMutation`)

```diff
       prompt: `${PROMPT_MUTATION}
 
-Agent: ${blueprint.name} (${blueprint.role})
+Agent: ${wrapUserInput("agent_name", blueprint.name)} (${wrapUserInput("agent_role", blueprint.role)})
 
 Current system prompt:
 ${wrapUserInput("system_prompt", blueprint.systemPrompt)}
```

### Block 2 — TOOL_CONFIG_MUTATION (lines 233–234, `generateToolConfigMutation`)

```diff
       prompt: `${TOOL_CONFIG_MUTATION}
 
-Agent: ${blueprint.name} (${blueprint.role})
-Current tools: ${JSON.stringify(blueprint.tools)}
+Agent: ${wrapUserInput("agent_name", blueprint.name)} (${wrapUserInput("agent_role", blueprint.role)})
+Current tools: ${wrapUserInput("agent_tools", JSON.stringify(blueprint.tools))}
 
 Recent benchmark results:
 ${wrapUserInput("benchmark_results", benchmarkSummary)}
```

### Block 3 — PHASE_LOGIC_MUTATION (lines 311–312, `generatePhaseLogicMutation`)

```diff
       prompt: `${PHASE_LOGIC_MUTATION}
 
-Agent: ${blueprint.name} (${blueprint.role})
-Current model: ${blueprint.model ?? "default (sonnet)"}
+Agent: ${wrapUserInput("agent_name", blueprint.name)} (${wrapUserInput("agent_role", blueprint.role)})
+Current model: ${wrapUserInput("agent_model", blueprint.model ?? "default (sonnet)")}
 
 Recent benchmark results:
 ${wrapUserInput("benchmark_results", benchmarkSummary)}
```

Net diff: **+5 / −5 lines** in a single file.

## Final wrapUserInput Call Sites in mutation-engine.ts

`grep -n "wrapUserInput" src/self-improve/mutation-engine.ts` (13 lines):

| Line | Tag                  | Wrapped Expression                                     | Prompt                       |
| ---- | -------------------- | ------------------------------------------------------ | ---------------------------- |
| 6    | (import)             | `import { ..., wrapUserInput } from "../utils/shared.js"` | —                            |
| 157  | `agent_name`         | `blueprint.name`                                       | PROMPT_MUTATION              |
| 157  | `agent_role`         | `blueprint.role`                                       | PROMPT_MUTATION              |
| 160  | `system_prompt`      | `blueprint.systemPrompt` (pre-existing)                | PROMPT_MUTATION              |
| 163  | `benchmark_results`  | `benchmarkSummary` (pre-existing)                      | PROMPT_MUTATION              |
| 166  | `mutation_history`   | `recentHistory || "No prior mutations"` (pre-existing) | PROMPT_MUTATION              |
| 233  | `agent_name`         | `blueprint.name`                                       | TOOL_CONFIG_MUTATION         |
| 233  | `agent_role`         | `blueprint.role`                                       | TOOL_CONFIG_MUTATION         |
| 234  | `agent_tools`        | `JSON.stringify(blueprint.tools)`                      | TOOL_CONFIG_MUTATION         |
| 237  | `benchmark_results`  | `benchmarkSummary` (pre-existing)                      | TOOL_CONFIG_MUTATION         |
| 240  | `mutation_history`   | `recentHistory || "No prior mutations"` (pre-existing) | TOOL_CONFIG_MUTATION         |
| 311  | `agent_name`         | `blueprint.name`                                       | PHASE_LOGIC_MUTATION         |
| 311  | `agent_role`         | `blueprint.role`                                       | PHASE_LOGIC_MUTATION         |
| 312  | `agent_model`        | `blueprint.model ?? "default (sonnet)"`                | PHASE_LOGIC_MUTATION         |
| 315  | `benchmark_results`  | `benchmarkSummary` (pre-existing)                      | PHASE_LOGIC_MUTATION         |
| 318  | `mutation_history`   | `recentHistory || "No prior mutations"` (pre-existing) | PHASE_LOGIC_MUTATION         |

Count by source:
- `grep -c "wrapUserInput" src/self-improve/mutation-engine.ts` = **13** (was 8; +5 new wrap call sites, with `agent_name` + `agent_role` co-located on the same line three times so `grep -c` counts the line not the call).
- `grep -c 'wrapUserInput("agent_' src/self-improve/mutation-engine.ts` = **5** (one line per new tag: three `agent_name`/`agent_role` shared lines + one `agent_tools` + one `agent_model` = 5 lines matching `wrapUserInput("agent_`).

Raw `${blueprint.name|role|model|tools}` inside a prompt template literal: **0** (verified via `grep -cE '^\s*(Agent:|Current tools:|Current model:) \$\{blueprint' src/self-improve/mutation-engine.ts` returning `0`).

## Verification Gates

| Gate                                                        | Result                 |
| ----------------------------------------------------------- | ---------------------- |
| Zero raw `${blueprint.…}` in prompts (`grep -cE` above)     | 0 — PASS               |
| `wrapUserInput("agent_` count (target ≥ 3)                  | 5 — PASS               |
| Total `wrapUserInput` count (target ≥ 13)                   | 13 — PASS              |
| `npm run typecheck`                                         | exit 0 — PASS          |
| `npx vitest run tests/self-improve/mutation-engine.test.ts` | 6/6 pass — PASS        |
| `npm test` (full suite)                                     | 807/807 pass — PASS    |
| `npm run lint`                                              | exit 0 — PASS          |

## Test Snapshot Updates

**None required.** `tests/self-improve/mutation-engine.test.ts` uses a `mockQuery` stub — `vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: (...args) => mockQuery(...args) }))` — and asserts on the `apply()`/`rollback()` return shapes and on `mutations[0]!.type` / `description` / `targetName` / `version`. It does **not** snapshot the exact `prompt:` string passed to `query()`. Changing the wire format of the prompt therefore left zero downstream test fixtures to update. All 6 mutation-engine tests and all 807 suite tests pass unchanged.

## Threat Model Disposition

From the plan's `<threat_model>`:

| Threat ID   | Category               | Component                                             | Plan Disposition | Post-Fix Status |
| ----------- | ---------------------- | ----------------------------------------------------- | ---------------- | --------------- |
| T-02-02-01  | Tampering              | blueprint fields injected into Meta-Optimizer prompt  | mitigate         | **Mitigated** — all four fields now XML-fenced per DEC-014. |
| T-02-02-02  | Elevation of Privilege | Prompt-injected "write this to disk as v{N}" instruction | mitigate         | **Mitigated** — the Meta-Optimizer cannot treat wrapped payload as meta-instruction; Zod `safeParse` on `ToolConfigResponseSchema` / `PhaseLogicResponseSchema` remains in place as the second defense layer. |
| T-02-02-03  | Information Disclosure | Injected instruction asking for other blueprints      | accept           | **Accepted** — `formatHistory` already summarizes, and wrapping closes the primary exfil path for the input side. |

## Deviations from Plan

**None.** The plan's three specified `Edit` operations were applied verbatim (the second Edit combined its two adjacent changes into one hunk, but the edited bytes are exactly what the plan prescribed). No auto-fixes (Rule 1/2/3) were triggered — the edit is self-contained, typecheck/tests/lint were clean before and after.

## Commits

| Task | Name                                                          | Commit   | Files                                  |
| ---- | ------------------------------------------------------------- | -------- | -------------------------------------- |
| 1    | Wrap the 5 raw interpolations with wrapUserInput              | 31b52c6  | src/self-improve/mutation-engine.ts    |
| 2    | Typecheck + tests (verification-only, no file changes)        | —        | —                                      |

Task 2 was verification-only (per plan: `<files>(no files modified — verification-only)</files>`), so it produced no commit; its outputs are the gate results recorded in the "Verification Gates" table above.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- **Wave 2 plan 02-02 complete.** CON-data-wrap-user-input is now clean for `src/self-improve/mutation-engine.ts`, the single file the Phase 2 backlog audit flagged.
- DEC-014 project-wide audit surface passes for this file; the remaining SEC-03..SEC-08 plans are file-scoped edits in other modules (lsp-manager, sandbox, security hooks, memory-store, path-traversal, api-key) and remain unblocked.
- Future new prompt template literals in `mutation-engine.ts` must wrap interpolations — add a grep check to pre-commit if this class of regression appears repeatedly.

## Self-Check: PASSED

- `src/self-improve/mutation-engine.ts`: FOUND (modified, +5/-5 lines, diff matches plan exactly)
- `.planning/phases/02-critical-security-backlog-closure/02-SUMMARY.md`: FOUND (this file)
- Commit `31b52c6`: FOUND in `git log --oneline -5`
- All seven verification gates (grep×3, typecheck, targeted tests, full tests, lint) executed and recorded above

---
*Phase: 02-critical-security-backlog-closure*
*Plan: 02 (SEC-02)*
*Completed: 2026-04-22*
