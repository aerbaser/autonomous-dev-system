# Phase 3: High-Priority Runtime Fixes - Context

**Gathered:** 2026-04-22
**Status:** Ready for planning
**Mode:** Auto-generated (discuss skipped via workflow.skip_discuss)

<domain>
## Phase Boundary

Close 6 HIGH-* items from PRODUCT.md §16 / REQUIREMENTS.md §High. Each has a named file or code path and a concrete acceptance criterion.

</domain>

<decisions>
## Implementation Decisions

All 6 items are LOCKED. Scope per item:

- HIGH-01: Rubric feedback loop fully wired in orchestrator — on `needs_revision` verdict and remaining retries, phase is re-run with verdict feedback in prompt; on `failed`, escalates to ledger with `verification_failed`
- HIGH-02: Grader never overwrites the LLM's structured verdict — verdict precedence rule documented and asserted
- HIGH-03: `Interrupter` singleton race fixed — parallel runs do not share singleton state in a way that drops SIGINT handlers
- HIGH-04: `src/phases/specification.ts` stub replaced with real handler; circular import resolved
- HIGH-05: `src/self-improve/optimizer-runner.ts` blueprint verification gate — no unverified blueprint accepted into the registry
- HIGH-06: Domain-agent ↔ task keyword matching wired into `development-runner.ts` so domain agents are actually selected for matching tasks

### Claude's Discretion

- Wave layout: HIGH-01 touches orchestrator, HIGH-02 touches verification path, HIGH-03 touches Interrupter — these may share files. HIGH-04 is isolated to specification.ts. HIGH-05 is isolated to optimizer-runner.ts. HIGH-06 is isolated to development-runner.ts. Planner should audit files_modified overlap before wave assignment.
- Whether to write new integration tests or extend existing (`tests/orchestrator/*`, `tests/self-improve/*`, `tests/phases/*`)

</decisions>

<code_context>
## Existing Code Insights

Runtime code paths are HIGH-risk — changes must preserve existing test signals. All changes must keep typecheck, lint, tests green. Follow .claude/skills/typescript/SKILL.md (SDK consumeQuery, errMsg, Zod, ESM .js imports).

</code_context>

<specifics>
## Specific Ideas

See REQUIREMENTS.md §v1 Requirements → High for the authoritative acceptance criteria. Every HIGH-01..HIGH-06 must be referenced in a plan's `requirements` field.

</specifics>

<deferred>
## Deferred Ideas

None — all 6 items in scope.

</deferred>
