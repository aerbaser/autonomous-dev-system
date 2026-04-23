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

- [x] **SEC-01**: SDK CVE GHSA-5474-4w2j-mq4c mitigated — `@anthropic-ai/claude-agent-sdk` pinned to `0.2.90` _(closed 2026-04-22, commit a13afda)_
- [x] **SEC-02**: `wrapUserInput(tag, content)` applied to every interpolated variable in `src/self-improve/mutation-engine.ts` _(closed 2026-04-22, commit a5b9be5)_
- [x] **SEC-03**: LSP install commands in `src/environment/lsp-manager.ts` gated by an executable allowlist _(closed 2026-04-22, commits 5def22e + dae96da)_
- [x] **SEC-04**: Sandbox allowlist + FORBIDDEN_BINARIES denylist enforced in `src/self-improve/sandbox.ts` _(closed 2026-04-22, commits 6bf8dbc + ef40a77 + 7d37f59)_
- [x] **SEC-05**: `src/hooks/security.ts` deny-list coverage extended to `Glob`, `Grep`, `Agent`, `WebFetch` tools _(closed 2026-04-22, commits 22e0271 + 3931021)_
- [x] **SEC-06**: ReDoS pattern in `src/state/memory-store.ts` `topicPattern` regex bounded with input length cap _(closed 2026-04-22, commits b3e2df0 + 41736d6 + 6459a62)_
- [x] **SEC-07**: Path-traversal hardening for all `.autonomous-dev/` subdirectories — every write site validated via `assertSafeWritePath` _(closed 2026-04-22, commit ba6bc33)_
- [x] **SEC-08**: Anthropic API key audited out of `Config` — lives only in `process.env`; invariant locked via 4 regression tests _(closed 2026-04-22, commits fe0ae31 + 7320923 + 3c22a03)_

### High-Priority Runtime Fixes (from PRODUCT.md §16 high-priority list)

- [x] **HIGH-01**: Rubric feedback loop fully wired in orchestrator — on `needs_revision` verdict and remaining retries, phase is re-run with verdict feedback in prompt; on `failed`, escalates to ledger with `verification_failed` _(closed 2026-04-22, commits 32b2b44 + 07a7519 + 7e55979 + 633a0f9)_
- [x] **HIGH-02**: Grader never overwrites the LLM's structured verdict — verdict precedence rule documented and asserted _(closed 2026-04-22, commits 312e738 + 9887fc4 + f4b4edf)_
- [x] **HIGH-03**: `Interrupter` singleton race fixed — per-run Interrupter stack; parallel runs do not cross-fire SIGINT _(closed 2026-04-22, commits a250d69 + 681518d + ab3c1fd + 25f8c97)_
- [x] **HIGH-04**: `src/phases/specification.ts` verified as real handler; no circular import; regression tests added _(closed 2026-04-22, commits cfeb319 + 9b0c675 + 0384d7d)_
- [x] **HIGH-05**: `src/self-improve/optimizer-runner.ts` blueprint verification gate wired — no unverified blueprint accepted into the registry _(closed 2026-04-22, commits 57db14c + a1a4191 + 78f4bde + ea140df + 7250489)_
- [x] **HIGH-06**: Domain-agent ↔ task keyword matching wired into `development-runner.ts` via `matchDomainAgentForTask` scorer _(closed 2026-04-22, commits 5f6e448 + b338a95)_

### v1.1 Super-Lead (shipped in parallel with v1.0 backlog closure)

Agent-team refactor landed alongside v1.0. Four decision-bearing phases (`architecture`, `review`, `testing`, `specification`) now run through a lead + specialists primitive when `AUTONOMOUS_DEV_LEAD_DRIVEN=1`. Default remains the single-query path for safety/backcompat.

- [x] **LEAD-01**: `PhaseContract<T>` type in `src/orchestrator/phase-contract.ts` — phase, goals, deliverables, allowedNextPhases, outputSchema, specialistNames, contextSelector, costCapUsd, maxBackloopsFromHere _(shipped 2026-04-22, commit f7dc46d; tests `tests/orchestrator/lead-driven-phase.test.ts`)_
- [x] **LEAD-02**: `runLeadDrivenPhase` primitive in `src/orchestrator/lead-driven-phase.ts` — builds specialist agent map, renders lead prompt, routes through `consumeQuery()` for SIGINT + EventBus propagation, validates envelope via `parseLeadEnvelope` _(shipped 2026-04-22, commit f7dc46d; tests `tests/orchestrator/lead-driven-phase.test.ts`)_
- [x] **LEAD-03**: `state.phaseAttempts: Record<Phase, PhaseResultSummary[]>` append-only history — every phase invocation including backloop re-entries is recorded; pre-v1.1 state.json migrates transparently via `.catch({})` in `ProjectStateSchema` _(shipped 2026-04-22, commit f338f59; tests `tests/state/phase-attempts.test.ts`)_
- [x] **LEAD-04**: `state.backloopCounts: Record<`${from}->${to}`, number>` per-pair counter + `incrementBackloopCount` / `isBackloopUnderCap` helpers in `src/orchestrator.ts` _(shipped 2026-04-22, commit f338f59; tests `tests/state/phase-attempts.test.ts`)_
- [x] **LEAD-05**: Livelock guard — `GLOBAL_MAX_BACKLOOPS = 5` in `src/orchestrator.ts`; denies further transitions, persists state, halts with `backloop_livelock_guard` log when a `${from}->${to}` pair fires 5 times _(shipped 2026-04-22, commit 01a2737; tests `tests/integration/backloop-e2e.test.ts`)_
- [x] **LEAD-06**: Opt-in via `AUTONOMOUS_DEV_LEAD_DRIVEN=1` env var checked at entry of each migrated phase handler (`architecture`, `review`, `testing`, `specification`); default path unchanged _(shipped 2026-04-22, commits aa49996 + 092f6df + 01a2737; per-phase lead-driven tests)_
- [x] **LEAD-07**: Phase specialists registered into `AgentRegistry` — 8 handwritten blueprints in `src/agents/phase-specialist-blueprints.ts`; `AgentRegistry.load()` backfills them into existing registries and initializes them on fresh registries alongside base blueprints _(shipped 2026-04-22, commit f7dc46d; covered in lead-driven-phase + per-phase tests)_
- [x] **LEAD-08**: Agent-tool denial invariant — `sanitizeSpecialistTools` defensively strips `Agent` from every specialist regardless of blueprint, so specialists cannot spawn their own coordinators; `factory.ts` and `development-runner.ts` also exclude phase specialists from domain-agent matching _(shipped 2026-04-22, commit f7dc46d; tests `tests/orchestrator/lead-driven-phase.test.ts`)_

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
| SEC-01 | Phase 2 | Complete (a13afda, 2026-04-22) |
| SEC-02 | Phase 2 | Complete (a5b9be5, 2026-04-22) |
| SEC-03 | Phase 2 | Complete (5def22e + dae96da, 2026-04-22) |
| SEC-04 | Phase 2 | Complete (6bf8dbc + ef40a77 + 7d37f59, 2026-04-22) |
| SEC-05 | Phase 2 | Complete (22e0271 + 3931021, 2026-04-22) |
| SEC-06 | Phase 2 | Complete (b3e2df0 + 41736d6 + 6459a62, 2026-04-22) |
| SEC-07 | Phase 2 | Complete (ba6bc33, 2026-04-22) |
| SEC-08 | Phase 2 | Complete (fe0ae31 + 7320923 + 3c22a03, 2026-04-22) |
| HIGH-01 | Phase 3 | Complete (32b2b44 + 07a7519 + 7e55979 + 633a0f9, 2026-04-22) |
| HIGH-02 | Phase 3 | Complete (312e738 + 9887fc4 + f4b4edf, 2026-04-22) |
| HIGH-03 | Phase 3 | Complete (a250d69 + 681518d + ab3c1fd + 25f8c97, 2026-04-22) |
| HIGH-04 | Phase 3 | Complete (cfeb319 + 9b0c675 + 0384d7d, 2026-04-22) |
| HIGH-05 | Phase 3 | Complete (57db14c + a1a4191 + 78f4bde + ea140df + 7250489, 2026-04-22) |
| HIGH-06 | Phase 3 | Complete (5f6e448 + b338a95, 2026-04-22) |
| VAL-02 | Phase 4 | Pending |
| VAL-03 | Phase 4 | Pending |
| VAL-04 | Phase 4 | Pending |
| VAL-05 | Phase 4 | Pending |
| GAP-01 | Phase 5 | Pending |
| GAP-02 | Phase 5 | Pending |
| GAP-03 | Phase 5 | Pending |
| VAL-06 | Phase 6 | Pending |
| VAL-07 | Phase 6 | Pending |
| LEAD-01 | v1.1 | Complete (f7dc46d, 2026-04-22) |
| LEAD-02 | v1.1 | Complete (f7dc46d, 2026-04-22) |
| LEAD-03 | v1.1 | Complete (f338f59, 2026-04-22) |
| LEAD-04 | v1.1 | Complete (f338f59, 2026-04-22) |
| LEAD-05 | v1.1 | Complete (01a2737, 2026-04-22) |
| LEAD-06 | v1.1 | Complete (aa49996 + 092f6df + 01a2737, 2026-04-22) |
| LEAD-07 | v1.1 | Complete (f7dc46d, 2026-04-22) |
| LEAD-08 | v1.1 | Complete (f7dc46d, 2026-04-22) |

**Coverage:**
- v1 requirements: 24 total (1 validation baseline + 8 security + 6 high-priority + 4 end-to-end validation + 3 product-gap + 2 self-improve validation)
- v1.1 super-lead requirements: 8 total (LEAD-01..LEAD-08, all shipped)
- Mapped to phases / milestones: 32
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-22*
*Last updated: 2026-04-23 — Phase 2 (SEC-01..08) and Phase 3 (HIGH-01..06) fully closed; v1.1 super-lead (LEAD-01..08) shipped.*
