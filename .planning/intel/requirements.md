# Requirements

Lifecycle and capability requirements derived from `PRODUCT.md` §3 (12-phase lifecycle) and supplementary sections. Each phase is one requirement; cross-cutting capabilities follow.

Source of truth: `/Users/admin/Desktop/AI/Web2/autonomous-dev-system/PRODUCT.md` (commit c4b504d, April 17, 2026).

---

## Lifecycle requirements (12 phases)

### REQ-phase-ideation

- **Source:** `PRODUCT.md` §3, row 1
- **Description:** Phase 1 (`ideation`). Idea string → `ProductSpec` + `DomainAnalysis` produced in parallel. Uses `WebSearch` for market research.
- **Acceptance:**
  - Phase produces `state.spec` populated with `ProductSpec` schema fields.
  - `DomainAnalysis` is computed in parallel (not sequentially after spec).
  - Phase result returns `costUsd` per `PhaseResult` contract.
- **Scope:** non-optional; cannot be skipped via `--quick`.

### REQ-phase-specification

- **Source:** `PRODUCT.md` §3, row 2
- **Description:** Phase 2 (`specification`). Refines initial spec into implementation-ready detail: refined Given/When/Then, NFR thresholds, all `ProductSpecSchema` fields populated.
- **Acceptance:**
  - Updates `state.spec` (does not overwrite domain analysis).
  - All Given/When/Then refined; NFRs have measurable thresholds.
- **Scope:** non-optional.

### REQ-phase-architecture

- **Source:** `PRODUCT.md` §3, row 3
- **Description:** Phase 3 (`architecture`). Spec → tech stack with explicit versions, components, apiContracts, databaseSchema, fileStructure, taskDecomposition. Triggers `buildAgentTeam()` to instantiate domain agents.
- **Acceptance:**
  - `state.architecture` populated with all listed sections.
  - `state.agents` populated by `buildAgentTeam()`.
  - Tech stack versions are explicit (no "latest").
- **Scope:** non-optional.

### REQ-phase-environment-setup

- **Source:** `PRODUCT.md` §3, row 4 + §6
- **Description:** Phase 4 (`environment-setup`). LSP, MCP, plugin discovery + OSS scan + project `CLAUDE.md` generation. Five parallel steps via `Promise.allSettled` so non-critical failures do not block.
- **Acceptance:**
  - `state.environment` populated.
  - Failed non-critical steps are logged but do not fail the phase.
  - Stack-specific examples produce expected tool sets (e.g., Next.js → vtsls + playwright/postgres/prisma MCPs).
- **Scope:** **OPTIONAL** — included in `OPTIONAL_PHASES`; skipped under `--quick`.

### REQ-phase-development

- **Source:** `PRODUCT.md` §3, row 5
- **Description:** Phase 5 (`development`). `development-runner.ts` decomposes tasks (priority: `architecture.taskDecomposition`), groups into batches by DAG, runs per-task agents. Each task produces a `TaskReceipt`. Quality gate runs after each batch.
- **Acceptance:**
  - `state.tasks` updated immutably as work progresses.
  - Workspace files written under writable root.
  - Each task has a persisted `TaskReceipt` at `.autonomous-dev/receipts/{runId}/{taskId}.json`.
  - Tasks marked completed only when `receipt.status === "success"`.
- **Scope:** non-optional.

### REQ-phase-testing

- **Source:** `PRODUCT.md` §3, row 6
- **Description:** Phase 6 (`testing`). Generates and runs tests. Returns structured `TestingResultSchema`.
- **Acceptance:**
  - `state.phaseResults.testing` populated with valid `TestingResultSchema`.
  - Cyclic transition `testing → development` available when verdict is `needs_revision`.
- **Scope:** non-optional.

### REQ-phase-review

- **Source:** `PRODUCT.md` §3, row 7
- **Description:** Phase 7 (`review`). Reviewer agent runs against changed files; security checks invoked. Returns structured `ReviewResultSchema`.
- **Acceptance:**
  - `state.phaseResults.review` populated.
  - Security checks executed.
  - Cyclic transition `review → development` available.
- **Scope:** **OPTIONAL** — skipped under `--quick`.

### REQ-phase-staging

- **Source:** `PRODUCT.md` §3, row 8
- **Description:** Phase 8 (`staging`). Deploy preview to staging. Implementation reuses the shared `runDeployment` function; environment differentiation via `state.environment`.
- **Acceptance:**
  - `state.deployment` populated.
  - No separate handler from `production`; both invoke `runDeployment`.
- **Scope:** non-optional.

### REQ-phase-ab-testing

- **Source:** `PRODUCT.md` §3, row 9
- **Description:** Phase 9 (`ab-testing`). Feature flags + experiment design. PostHog integration is conceptual; not fully implemented.
- **Acceptance:**
  - `state.abTests` populated when phase runs.
  - Phase tolerates absence of PostHog credentials.
- **Scope:** **OPTIONAL** — skipped under `--quick`.

### REQ-phase-analysis

- **Source:** `PRODUCT.md` §3, row 10
- **Description:** Phase 10 (`analysis`). Analyzes experiment data, formulates hypothesis for the next iteration.
- **Acceptance:**
  - `state.phaseResults.analysis` populated.
  - Cyclic transition `analysis → development` available for follow-up implementation.
- **Scope:** non-optional.

### REQ-phase-production

- **Source:** `PRODUCT.md` §3, row 11
- **Description:** Phase 11 (`production`). Production deploy via the same `runDeployment` function used by staging.
- **Acceptance:**
  - `state.deployment` updated with production environment marker.
  - Same code path as staging; no parallel implementation.
- **Scope:** non-optional.

### REQ-phase-monitoring

- **Source:** `PRODUCT.md` §3, row 12
- **Description:** Phase 12 (`monitoring`). Collects production metrics; returns structured `MonitoringResultSchema`. Triggers continuous improvement.
- **Acceptance:**
  - `state.phaseResults.monitoring` populated.
  - Transition `monitoring → development` available.
- **Scope:** **OPTIONAL** — skipped under `--quick`.

---

## Cross-cutting requirements

### REQ-checkpoint-recovery

- **Source:** `PRODUCT.md` §1, §16
- **Description:** Run state persisted to `.autonomous-dev/state.json` after each phase. Operator can resume from any checkpoint via `--resume <sessionId>`.
- **Acceptance:**
  - SIGINT triggers graceful shutdown; state written before exit.
  - `--resume` restores all phase results and continues from the next valid phase.

### REQ-budget-cap

- **Source:** `PRODUCT.md` §11 (SpendGovernor) + §13 (CLI)
- **Description:** `--budget <usd>` flag enforces a cap on `state.totalCostUsd`. Warning at 80%; graceful stop at 100% via Interrupter.
- **Acceptance:**
  - At ≥80% spend, warning emitted.
  - At 100% spend, current phase completes and no new phase starts.
  - Known gap: in-flight phase cost lost on interrupt before `result.success` (backlog item, not blocking).

### REQ-dry-run

- **Source:** `PRODUCT.md` §13 (CLI)
- **Description:** `--dry-run` previews the phase plan, agent assignments, and cost estimate without spending API credits.
- **Acceptance:**
  - No `query()` calls executed.
  - Cost estimate based on token estimates, not actual spend.

### REQ-quick-mode

- **Source:** `PRODUCT.md` §3 + §13 (CLI)
- **Description:** `--quick` skips all `OPTIONAL_PHASES`: `environment-setup`, `review`, `ab-testing`, `monitoring`.
- **Acceptance:**
  - Exactly these 4 phases skipped; no others.
  - Skip is via quick-skip logic in orchestrator (handler not invoked, transition still occurs).

### REQ-confirm-spec-gate

- **Source:** `PRODUCT.md` §13 (CLI)
- **Description:** `--confirm-spec` pauses execution after `ideation` and waits for operator approval before continuing to `specification`.
- **Acceptance:**
  - Pause is observable (process does not exit).
  - Approval can be denied to abort the run.

### REQ-self-improve-optimize

- **Source:** `PRODUCT.md` §5
- **Description:** `autonomous-dev optimize --max-iterations N` runs the hill-climbing self-improvement loop. Mutations applied in git worktree; accepted on score improvement, rolled back otherwise.
- **Acceptance:**
  - All mutations isolated in worktrees; cleanup in `finally`.
  - Accepted mutations versioned as `{agentName}.v{N}.md`.
  - `state.evolution[]` records diff and old/new scores.
  - Convergence detection respects `windowSize`, `minImprovement`, `maxStagnant`.

### REQ-nightly-runner

- **Source:** `PRODUCT.md` §13 (CLI)
- **Description:** `autonomous-dev nightly` performs unattended optimize + dashboard maintenance. Skips Codex preflight via `NIGHTLY_ENV_FLAG`.
- **Acceptance:**
  - Generates updated `.autonomous-dev/dashboard.html`.
  - Optionally runs optimizer (skipped via `--skip-optimize`).
  - Survives transient errors without exiting.

### REQ-dashboard

- **Source:** `PRODUCT.md` §7 (Dashboard)
- **Description:** `autonomous-dev dashboard` generates `.autonomous-dev/dashboard.html` from current state + event log. Snapshot-based, not real-time.
- **Acceptance:**
  - File generated at `.autonomous-dev/dashboard.html`.
  - Includes phases, agents, costs, evolution entries.

### REQ-event-bus

- **Source:** `PRODUCT.md` §7 (EventBus)
- **Description:** Typed in-memory pub/sub for orchestrator/agent/evaluation/memory/session events. EventLogger persists each event as JSONL to `.autonomous-dev/events/{runId}.jsonl`.
- **Acceptance:**
  - Every event has `{type, timestamp, seq, data}` envelope.
  - `generateRunSummary()` produces aggregated `{runId}.summary.json`.

### REQ-rubric-evaluation-loop

- **Source:** `PRODUCT.md` §9
- **Description:** Per-phase rubric evaluation when `config.rubric.enabled = true` (or `--enable-rubrics`). On `needs_revision` verdict and remaining retries, phase is re-run with feedback in prompt. On `failed`, escalates to ledger with `verification_failed`.
- **Acceptance:**
  - Off by default for cost reasons.
  - Uses `RubricResultSchema` for structured grading.

### REQ-task-receipts

- **Source:** `PRODUCT.md` §10
- **Description:** Every development task produces a `TaskReceipt` validated against `TaskReceiptSchema`. Persisted to `.autonomous-dev/receipts/{runId}/{taskId}.json`.
- **Acceptance:**
  - Receipt status `success | failed | blocked | partial`.
  - Optional `failureReasonCode` (open-ended union).
  - Optional `freeformNotes` does not affect status.

### REQ-execution-envelope

- **Source:** `PRODUCT.md` §12
- **Description:** Every delegated task receives a validated `ExecutionEnvelope` (project root, writable root, branch, package manager, allowed verification commands, environment).
- **Acceptance:**
  - Envelope rendered as XML and inlined into task prompt.
  - Package manager detected from lockfiles with `bun > pnpm > yarn > npm` precedence.

### REQ-layered-memory

- **Source:** `PRODUCT.md` §8
- **Description:** Layered memory L0 (meta-rules) / L2 (global facts) / L3 (skill playbooks) / L4 (session archive). MemoryStore provides cross-session knowledge retrieval (search → inject before phase, learnings captured after).
- **Acceptance:**
  - L0 meta-rules injected into all system prompts.
  - L3 skill playbooks injected on signature match in development-runner.
  - L4 session summary written in `finally` block of run.
  - L1 not present (removed as dead code).

### REQ-codex-subagents

- **Source:** `PRODUCT.md` §4 (Codex-backed subagents)
- **Description:** When enabled, Opus orchestrates while implementation is delegated to `codex exec` on `gpt-5.4`. Fail-closed preflight rejects start if `codex` binary missing.
- **Acceptance:**
  - Disabled by default (`config.codexSubagents.enabled = false`).
  - On enabled + missing binary, throws `UnsupportedTeamRuntimeError`.

### REQ-ask-user-gate

- **Source:** `PRODUCT.md` §10 (Ask-user hook)
- **Description:** Mid-phase clarification gate. Disabled by default (`config.interactive.allowAskUser = false`); when disabled, questions are journaled to `.autonomous-dev/pending-questions.jsonl`. When enabled, blocks on TTY.
- **Acceptance:**
  - Off by default.
  - Off mode never blocks; questions discoverable post-run via journal.

### REQ-status-command

- **Source:** `PRODUCT.md` §13 (CLI)
- **Description:** `autonomous-dev status` prints current run state.

### REQ-single-phase-command

- **Source:** `PRODUCT.md` §13 (CLI)
- **Description:** `autonomous-dev phase --name <phase>` runs a single phase from prior state. Supports `--stack <tech,...>` override at environment-setup.
