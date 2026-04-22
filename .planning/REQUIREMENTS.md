# Requirements: autonomous-dev-system

**Defined:** 2026-04-22
**Core Value:** The operator can hand the system a product idea and get an end-to-end implemented, tested, reviewed, and deployed artifact without writing code themselves, with full cost visibility, checkpoint recovery, and a self-improvement loop that makes the system better over time.

> **Brownfield note.** This project is mature. The 21 lifecycle + cross-cutting requirements derived from `PRODUCT.md` (in `.planning/intel/requirements.md`) are already SHIPPED in code as of commit 19c663f. They are listed below in the **Validated** block for traceability. The **v1 (Active)** block is the current milestone: closing known gaps + proving end-to-end validation on a real toy idea.

## Validated Requirements (already in code)

These map to the 21 entries in `.planning/intel/requirements.md`. They are present in `src/`, covered by 777/777 passing vitest as of 2026-04-22 (Phase 1 / VAL-01 closed in commit 4fc0ce5). They are listed for full traceability and to make clear which acceptance work the active v1 milestone is *not* re-doing.

### Lifecycle (12 phases)

- [x] **REQ-phase-ideation** — `src/phases/ideation.ts` produces `state.spec` (`ProductSpec`) and `DomainAnalysis` in parallel; returns `costUsd`.
- [x] **REQ-phase-specification** — `src/phases/specification.ts` refines spec with NFR thresholds + Given/When/Then. (Stub-replacement and circular-import cleanup tracked in HIGH-04 below.)
- [x] **REQ-phase-architecture** — `src/phases/architecture.ts` emits tech stack with explicit versions, components, apiContracts, databaseSchema, fileStructure, taskDecomposition; triggers `buildAgentTeam()`.
- [x] **REQ-phase-environment-setup** *(OPTIONAL)* — `src/phases/environment-setup.ts` runs LSP/MCP/plugin/OSS/CLAUDE.md generation in parallel via `Promise.allSettled`.
- [x] **REQ-phase-development** — `src/phases/development-runner.ts` decomposes tasks (priority: `architecture.taskDecomposition`), batches by DAG, persists `TaskReceipt` per task at `.autonomous-dev/receipts/{runId}/{taskId}.json`.
- [x] **REQ-phase-testing** — `src/phases/testing.ts` returns `TestingResultSchema`; `testing → development` cyclic transition available.
- [x] **REQ-phase-review** *(OPTIONAL)* — `src/phases/review.ts` returns `ReviewResultSchema`; security checks invoked.
- [x] **REQ-phase-staging** — `src/phases/deployment.ts` `runDeployment` invoked with `state.environment === "staging"`.
- [x] **REQ-phase-ab-testing** *(OPTIONAL)* — `src/phases/ab-testing.ts` writes `state.abTests`; tolerates missing PostHog credentials. (Real PostHog wiring tracked in GAP-01.)
- [x] **REQ-phase-analysis** — `src/phases/analysis.ts` formulates next-iteration hypothesis; `analysis → development` cyclic transition available.
- [x] **REQ-phase-production** — Same `runDeployment` as staging, with `state.environment === "production"`.
- [x] **REQ-phase-monitoring** *(OPTIONAL)* — `src/phases/monitoring.ts` returns `MonitoringResultSchema`; `monitoring → development` available.

### Cross-cutting

- [x] **REQ-checkpoint-recovery** — `.autonomous-dev/state.json` written after each phase; `--resume <sessionId>` restores all phase results.
- [x] **REQ-budget-cap** — `--budget <usd>` warns at 80%, graceful stop at 100% via Interrupter. (In-flight phase cost loss before `result.success` is a tracked gap, not blocking.)
- [x] **REQ-dry-run** — `--dry-run` previews plan + cost estimate without `query()` calls.
- [x] **REQ-quick-mode** — `--quick` skips exactly the 4 phases in `OPTIONAL_PHASES`.
- [x] **REQ-confirm-spec-gate** — `--confirm-spec` pauses post-ideation. (Non-interactive test timeout resolved 2026-04-22 in commit 4fc0ce5; VAL-01 closed.)
- [x] **REQ-self-improve-optimize** — `autonomous-dev optimize --max-iterations N` with hill-climbing in worktree sandbox; convergence respects `windowSize`, `minImprovement`, `maxStagnant`.
- [x] **REQ-nightly-runner** — `autonomous-dev nightly` skips Codex preflight via `NIGHTLY_ENV_FLAG`; produces dashboard.
- [x] **REQ-dashboard** — `autonomous-dev dashboard` writes `.autonomous-dev/dashboard.html`.
- [x] **REQ-event-bus** — Typed pub/sub; `EventLogger` persists to `.autonomous-dev/events/{runId}.jsonl`; `generateRunSummary()` produces `{runId}.summary.json`.
- [x] **REQ-rubric-evaluation-loop** — `RubricResultSchema` grading when `config.rubric.enabled = true`. (Full feedback-loop wiring in orchestrator is HIGH-01.)
- [x] **REQ-task-receipts** — `TaskReceiptSchema` validation; `failureReasonCode` open-ended; `freeformNotes` debug-only.
- [x] **REQ-execution-envelope** — `buildEnvelope()` produces validated context; rendered as XML and inlined.
- [x] **REQ-layered-memory** — L0 meta-rules, L2 global facts (persisted; injection deferred), L3 skill playbooks via `SkillStore`, L4 session archive JSONL. L1 absent (DEC-021).
- [x] **REQ-codex-subagents** — Opt-in via `config.codexSubagents.enabled = true`; preflight throws `UnsupportedTeamRuntimeError` if `codex` binary missing. Default off.
- [x] **REQ-ask-user-gate** — Default off; questions journal to `.autonomous-dev/pending-questions.jsonl`. When enabled, blocks on TTY.
- [x] **REQ-status-command** — `autonomous-dev status` prints current run state.
- [x] **REQ-single-phase-command** — `autonomous-dev phase --name <phase>` runs one phase from prior state; supports `--stack <tech,...>` override at `environment-setup`.

## v1 Requirements

The current milestone is **v1.0 Validation & Hardening**. Goal: prove the existing system works end-to-end on a real toy idea AND close the critical security/high-priority backlog from PRODUCT.md §16. Each requirement maps to exactly one phase.

### Validation

- [x] **VAL-01**: Baseline test suite is 777/777 green — the one currently failing case (non-interactive `--confirm-spec` timeout in `tests/integration/orchestrator-autonomy.test.ts`) is fixed without regressing other tests _(closed 2026-04-22, commit 4fc0ce5)_
- [ ] **VAL-02**: Full 12-phase pipeline runs to completion against a chosen toy idea (non-quick) with all phase results, agents, and artifacts captured
- [ ] **VAL-03**: `--resume <sessionId>` restores an interrupted toy-idea run from a mid-phase checkpoint
- [ ] **VAL-04**: `--budget <usd>` enforces a hard cap on a toy-idea run — 80% warning emitted, 100% stop is graceful (no orphaned in-flight task)
- [ ] **VAL-05**: SIGINT during a toy-idea run triggers graceful shutdown with state written before exit
- [ ] **VAL-06**: `autonomous-dev optimize --max-iterations N` runs against the toy-idea agent team and produces at least one accepted versioned blueprint (`{name}.v{N}.md`) plus a `state.evolution[]` entry, OR clean rejection with no working-dir contamination
- [ ] **VAL-07**: `autonomous-dev nightly` runs unattended and produces an updated `.autonomous-dev/dashboard.html` reflecting the toy-idea run

### Critical Security (from PRODUCT.md §16 critical list)

- [x] **SEC-01
**: SDK CVE GHSA-5474-4w2j-mq4c mitigated — `@anthropic-ai/claude-agent-sdk` downgraded to `0.2.90` or pinned to a fixed version; CI passes
- [x] **SEC-02
**: `wrapUserInput(tag, content)` applied to every interpolated variable in `src/self-improve/mutation-engine.ts`
- [x] **SEC-03**: LSP install commands in `src/environment/lsp-manager.ts` gated by an executable allowlist (split on whitespace + check executable name) — completed 2026-04-22 (commits 5def22e, dae96da)
- [x] **SEC-04
**: Sandbox executable allowlist enforced in `src/self-improve/sandbox.ts` — forbidden binaries cannot be invoked from a mutation worktree
- [ ] **SEC-05**: `src/hooks/security.ts` deny-list coverage extended to `Glob`, `Grep`, `Agent`, `WebFetch` tools (currently only Bash/Read/Write/Edit)
- [ ] **SEC-06**: ReDoS pattern in `src/state/memory-store.ts` `topicPattern` regex bounded with input length cap and/or non-backtracking pattern
- [x] **SEC-07
**: Path-traversal hardening for all `.autonomous-dev/` subdirectories — every write site validated, not only `stateDir`
- [ ] **SEC-08**: Anthropic API key removed from any `Config` field — lives only in `process.env`; no logged or serialized location

### High-Priority Runtime Fixes (from PRODUCT.md §16 high-priority list)

- [ ] **HIGH-01**: Rubric feedback loop fully wired in orchestrator — on `needs_revision` verdict and remaining retries, phase is re-run with verdict feedback in prompt; on `failed`, escalates to ledger with `verification_failed`
- [ ] **HIGH-02**: Grader never overwrites the LLM's structured verdict — verdict precedence rule documented and asserted
- [ ] **HIGH-03**: `Interrupter` singleton race fixed — parallel runs do not share singleton state in a way that drops SIGINT handlers
- [ ] **HIGH-04**: `src/phases/specification.ts` stub replaced with real handler; circular import resolved
- [ ] **HIGH-05**: `src/self-improve/optimizer-runner.ts` blueprint verification gate — no unverified blueprint accepted into the registry
- [ ] **HIGH-06**: Domain-agent ↔ task keyword matching wired into `development-runner.ts` so domain agents are actually selected for matching tasks

### Product Gaps (from PRODUCT.md §16 product-gap list)

- [ ] **GAP-01**: PostHog integration real for `ab-testing` phase — feature flags created/read, experiment events emitted; phase still tolerates missing creds (graceful skip path remains)
- [ ] **GAP-02**: Cloud-deploy integration fleshed out for `staging` + `production` via shared `runDeployment` — at least one real provider target wired (e.g. Vercel, Fly, or Render) end-to-end
- [ ] **GAP-03**: `autonomous-dev init` guided-setup command — interactive bootstrap of `.autonomous-dev/config.json`, optional Codex preflight check, sample idea selection

## v2 Requirements

Acknowledged but explicitly deferred. Tracked here so they don't get re-introduced into v1.

### Memory

- **L2-INJECT-01**: Inject persisted L2 global facts into phase prompts (currently L2 is written but not consumed).

### Native Runtime Migration

- **TEAMS-01**: Resume the partially-executed Agent Teams native runtime migration (Phases 1, 4, 6, 7, 10 done per `docs/archive/2026-04-10-agent-teams-native-execution-plan.md`) — remaining phases backlogged.

### Dashboard

- **DASH-LIVE-01**: Replace the static-HTML dashboard with a real-time streaming UI (PRODUCT.md §16 product-gap; explicitly out of scope for v1).
- **STREAM-01**: Real-time stdout streaming of LLM output during a run.

### Spend Governance

- **SPEND-01**: Capture in-flight phase cost on `--budget` interrupt before `result.success` (currently lost on stop mid-phase).

### Templates / Starters

- **TPL-01**: Template / starter system so `run` can bootstrap from a known-good template instead of always synthesizing from idea string.

### Memory limits

- **MEM-TTL-01**: True TTL on MemoryStore documents (currently FIFO by `updatedAt`).

## Out of Scope

| Feature | Reason |
|---------|--------|
| Real-time web UI / streaming dashboard | PRODUCT.md §1 and §16: dashboard is intentionally a static HTML snapshot for this milestone. |
| Real-time stdout streaming of LLM output | Same — explicitly deferred per `docs/archive/VIBE-REVIEW.md`. |
| Native Agent Teams runtime migration | DEC-018: subagents chosen for MVP; remaining migration phases backlogged. |
| L1 memory layer | DEC-021: removed as dead code; no re-introduction. |
| `bypassPermissions` SDK permission mode | DEC-010: blocked under root; `acceptEdits` is the only autonomous mode. |
| In-place state mutation | DEC-016: immutable updates only. |
| Direct `query()` calls bypassing `consumeQuery()` | DEC-015: cost/token tracking required centrally. |
| Casting `JSON.parse` results without Zod `safeParse` | DEC-013: cast-based parsing is the #1 crash source. |
| Forking deployment logic per phase | DEC-004: staging + production share `runDeployment`; environment-based differentiation only. |
| Duplicating `OPTIONAL_PHASES` outside `src/types/phases.ts` | DEC-002: single-source rule. |
| Non-XML-delimited user-derived prompt content | DEC-014: `wrapUserInput` mandatory project-wide. |
| Template / starter system | PRODUCT.md §16 product-gap; deferred to v2 (TPL-01). |
| L2 fact injection into phase prompts in this milestone | Deferred to v2 (L2-INJECT-01); L2 is persisted but not consumed yet. |

## Traceability

Every v1 requirement maps to exactly one phase in `ROADMAP.md`.

| Requirement | Phase | Status |
|-------------|-------|--------|
| VAL-01 | Phase 1 | Complete (4fc0ce5, 2026-04-22) |
| SEC-01 | Phase 2 | Pending |
| SEC-02 | Phase 2 | Pending |
| SEC-03 | Phase 2 | Complete (5def22e, dae96da, 2026-04-22) |
| SEC-04 | Phase 2 | Pending |
| SEC-05 | Phase 2 | Pending |
| SEC-06 | Phase 2 | Pending |
| SEC-07 | Phase 2 | Pending |
| SEC-08 | Phase 2 | Pending |
| HIGH-01 | Phase 3 | Pending |
| HIGH-02 | Phase 3 | Pending |
| HIGH-03 | Phase 3 | Pending |
| HIGH-04 | Phase 3 | Pending |
| HIGH-05 | Phase 3 | Pending |
| HIGH-06 | Phase 3 | Pending |
| VAL-02 | Phase 4 | Pending |
| VAL-03 | Phase 4 | Pending |
| VAL-04 | Phase 4 | Pending |
| VAL-05 | Phase 4 | Pending |
| GAP-01 | Phase 5 | Pending |
| GAP-02 | Phase 5 | Pending |
| GAP-03 | Phase 5 | Pending |
| VAL-06 | Phase 6 | Pending |
| VAL-07 | Phase 6 | Pending |

**Coverage:**
- v1 requirements: 24 total (1 validation baseline + 8 security + 6 high-priority + 4 end-to-end validation + 3 product-gap + 2 self-improve validation)
- Mapped to phases: 24
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-22*
*Last updated: 2026-04-22 — Phase 1 / VAL-01 closed (commit 4fc0ce5).*
