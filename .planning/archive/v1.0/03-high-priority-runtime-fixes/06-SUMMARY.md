---
phase: 03-high-priority-runtime-fixes
plan: 06
requirements:
  - HIGH-06
status: complete
completed_at: 2026-04-22
---

# HIGH-06 — Domain-agent ↔ task keyword matching

## Objective

Wire keyword-based domain-agent selection into `src/phases/development-runner.ts` so that when a task is dispatched, the system picks the domain agent whose `keywords` best match the task title/description/tags. Fallback to the default agent when no match scores above 0.

## Changes

- **`src/types/llm-schemas.ts`** — `AgentBlueprintSchema.keywords: z.array(z.string()).optional()` added (optional at storage boundary, required at LLM-emit boundary)
- **`src/agents/domain-analyzer.ts`** — LLM-emit schema requires `keywords` so every freshly generated blueprint carries domain keywords
- **`src/phases/development-runner.ts`** — new exported pure function `matchDomainAgentForTask(task, domainAgents): AgentBlueprint | undefined`. Scoring: +3 if agent name in title, +2 if role in title, +1 per keyword hit in title/description, +1 per keyword equality with a tag. Tie-break by input order (first registered wins). Returns `undefined` when total score is 0 so callers can cleanly fall back.
- **`tests/phases/development-runner.test.ts`** — 5 regression tests locking the contract: keyword match, no-match fallback, tag-score precedence, tie-break order, name/role matching

## Verification

- `npm run typecheck` — exit 0
- `npm test -- tests/phases/development-runner.test.ts --run` — 35/35 passing (30 pre-existing + 5 new HIGH-06)
- `npm run lint` — exit 0

## Deviations

None — plan executed as written.

## Closes

- REQUIREMENTS.md HIGH-06
- ROADMAP.md Phase 3 Plan 06 (checkbox)
