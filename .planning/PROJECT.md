# autonomous-dev-system

**Version:** 0.1.0
**Status:** Mature code-complete; entering validation/hardening milestone.

## What This Is

A self-improving multi-agent development system built on the Claude Agent SDK. Given a product idea string, the orchestrator drives it through a 12-phase lifecycle (ideation → specification → architecture → environment-setup → development → testing → review → staging → ab-testing → analysis → production → monitoring) while dynamically generating domain-specific agents, auto-configuring the dev environment, and running a benchmark-driven self-improvement loop that mutates agent prompts in git-worktree sandboxes. It is a backend orchestrator, not a UI — the dashboard is a static HTML snapshot by design.

## Core Value

The operator can hand the system a product idea and get an end-to-end implemented, tested, reviewed, and deployed artifact without writing code themselves, with full cost visibility, checkpoint recovery, and a self-improvement loop that makes the system better over time.

## Requirements

### Validated

<!-- Shipped and present in code as of commit 19c663f (Apr 22, 2026). Confirmed by 776/777 passing vitest + clean typecheck/lint. -->

- [x] **REQ-phase-ideation** — Phase 1 ideation produces `ProductSpec` + parallel `DomainAnalysis` (shipped, covered by tests)
- [x] **REQ-phase-specification** — Phase 2 refines spec with NFR thresholds and Given/When/Then (shipped; specification-stub backlog item tracked separately)
- [x] **REQ-phase-architecture** — Phase 3 emits tech stack + agent team via `buildAgentTeam()` (shipped)
- [x] **REQ-phase-environment-setup** — Phase 4 runs 5 parallel steps (LSP, MCP, plugins, OSS scan, CLAUDE.md) via `Promise.allSettled` (shipped, OPTIONAL)
- [x] **REQ-phase-development** — Phase 5 `development-runner.ts` decomposes and runs task batches with `TaskReceipt` per task (shipped)
- [x] **REQ-phase-testing** — Phase 6 generates/runs tests with structured `TestingResultSchema` (shipped)
- [x] **REQ-phase-review** — Phase 7 reviewer agent + structured `ReviewResultSchema` (shipped, OPTIONAL)
- [x] **REQ-phase-staging** — Phase 8 deploys preview via shared `runDeployment` (shipped)
- [x] **REQ-phase-ab-testing** — Phase 9 feature-flag and experiment scaffolding (shipped, OPTIONAL; PostHog wiring is stub)
- [x] **REQ-phase-analysis** — Phase 10 analyzes experiments and formulates next-iteration hypothesis (shipped)
- [x] **REQ-phase-production** — Phase 11 production deploy via shared `runDeployment` (shipped)
- [x] **REQ-phase-monitoring** — Phase 12 collects metrics via `MonitoringResultSchema` (shipped, OPTIONAL)
- [x] **REQ-checkpoint-recovery** — `.autonomous-dev/state.json` + `--resume` + SIGINT-safe shutdown (shipped)
- [x] **REQ-budget-cap** — `--budget <usd>` with 80% warning, 100% graceful stop (shipped; in-flight phase cost gap tracked)
- [x] **REQ-dry-run** — `--dry-run` plans without spending API credits (shipped)
- [x] **REQ-quick-mode** — `--quick` skips exactly the 4 `OPTIONAL_PHASES` (shipped)
- [x] **REQ-confirm-spec-gate** — `--confirm-spec` pause after ideation (shipped; 1 test currently fails in non-interactive mode, see Active)
- [x] **REQ-self-improve-optimize** — `autonomous-dev optimize` with hill-climbing + worktree sandbox + versioning (shipped)
- [x] **REQ-nightly-runner** — `autonomous-dev nightly` with Codex preflight skip via `NIGHTLY_ENV_FLAG` (shipped)
- [x] **REQ-dashboard** — `autonomous-dev dashboard` static HTML at `.autonomous-dev/dashboard.html` (shipped)
- [x] **REQ-event-bus** — EventBus + EventLogger JSONL at `.autonomous-dev/events/{runId}.jsonl` (shipped)
- [x] **REQ-rubric-evaluation-loop** — Profile-gated rubric grader (shipped; orchestrator wiring for feedback-loop retry is gap, see Active)
- [x] **REQ-task-receipts** — `TaskReceipt` schema-validated, persisted per task (shipped)
- [x] **REQ-execution-envelope** — XML envelope (`projectRoot`, `writableRoot`, `branch`, `packageRoot?`, `allowedVerificationCommands[]`, `environment`) inlined into every delegated task (shipped)
- [x] **REQ-layered-memory** — L0/L2/L3/L4 LayeredMemory + SkillStore + MemoryStore + memory-capture hook (shipped; L2 injection into prompts deferred)
- [x] **REQ-codex-subagents** — Opt-in Codex subagents with fail-closed preflight via `UnsupportedTeamRuntimeError` (shipped, default off)
- [x] **REQ-ask-user-gate** — Journal-mode default via `.autonomous-dev/pending-questions.jsonl` (shipped, default off)
- [x] **REQ-status-command** — `autonomous-dev status` prints current run state (shipped)
- [x] **REQ-single-phase-command** — `autonomous-dev phase --name <phase>` runs one phase from prior state (shipped)

### Active

<!-- Current scope for v1.0 validation & hardening milestone — see ROADMAP.md Phases 1-6. -->

- [ ] **VAL-01**: Baseline is green (777/777 passing including non-interactive confirm-spec timeout case)
- [ ] **VAL-02**: Full 12-phase pipeline validated on a real toy idea with captured artifacts (non-quick)
- [ ] **VAL-03**: `--resume` proven on interrupted toy-idea run
- [ ] **VAL-04**: `--budget` proven to stop a toy-idea run at cap with graceful shutdown
- [ ] **VAL-05**: Self-improve `optimize` + `nightly` run end-to-end against the toy-idea agent team and produce a versioned blueprint + updated dashboard
- [ ] **SEC-01**: SDK CVE GHSA-5474-4w2j-mq4c mitigated (`@anthropic-ai/claude-agent-sdk` downgraded to `0.2.90` or fixed version pinned)
- [ ] **SEC-02**: `wrapUserInput` applied to every interpolated variable in `src/self-improve/mutation-engine.ts`
- [ ] **SEC-03**: LSP install commands gated by executable allowlist in `src/environment/lsp-manager.ts`
- [ ] **SEC-04**: Sandbox executable allowlist enforced in `src/self-improve/sandbox.ts`
- [ ] **SEC-05**: Security hook coverage extended to `Glob`, `Grep`, `Agent`, `WebFetch` tools in `src/hooks/security.ts`
- [ ] **SEC-06**: ReDoS pattern in `src/state/memory-store.ts` `topicPattern` regex bounded
- [ ] **SEC-07**: Path-traversal hardening for all `.autonomous-dev/` subdirectories (beyond existing `assertSafePath(stateDir)`)
- [ ] **SEC-08**: Anthropic API key removed from `Config` object — lives only in `process.env`
- [ ] **HIGH-01**: Rubric feedback loop fully wired in orchestrator (`needs_revision` → re-run with feedback; current wiring is conditional)
- [ ] **HIGH-02**: Grader never overwrites the LLM's structured verdict
- [ ] **HIGH-03**: `Interrupter` singleton race fixed for parallel runs
- [ ] **HIGH-04**: Specification phase stub replaced with real handler + circular import resolved
- [ ] **HIGH-05**: Optimizer-runner blueprint verification gate (no unverified blueprints accepted)
- [ ] **HIGH-06**: Domain-agent ↔ task keyword matching in `development-runner.ts`
- [ ] **GAP-01**: PostHog integration real for `ab-testing` phase (not just conceptual scaffolding)
- [ ] **GAP-02**: Cloud-deploy integration fleshed out for `staging` + `production` via shared `runDeployment` (at least one real target)
- [ ] **GAP-03**: `autonomous-dev init` guided-setup command (scope TBD)

### Out of Scope

<!-- Explicit boundaries. Includes reasoning to prevent re-adding. -->

- Real-time web UI / streaming dashboard — PRODUCT.md §16 states dashboard is intentionally a static HTML snapshot; full UI is a separate, non-committed initiative
- Real-time stdout streaming of LLM output — Same reasoning; archive `VIBE-REVIEW.md` explicitly defers this
- Template / starter system — Always builds from-scratch from idea string (PRODUCT.md §16, product-gap list); template system is not part of this milestone
- Native Agent Teams runtime migration — Subagents chosen for MVP per DEC-018; remaining migration phases (`docs/archive/2026-04-10-agent-teams-native-execution-plan.md`) are backlogged
- L1 memory layer — Removed as dead code (DEC-021); no re-introduction
- `bypassPermissions` SDK permission mode — DEC-010 locks `acceptEdits`; root-blocked mode is forbidden
- In-place state mutation — DEC-016 requires immutable updates returning new state objects
- L2 fact injection into phase prompts — Deferred (PRODUCT.md §8); L2 is persisted but not yet consumed; tracked as future enhancement, not this milestone
- Skipping `consumeQuery()` wrapper — DEC-015 forbids direct `query()` calls; no exceptions

## Context

**Codebase maturity.** This is not a greenfield. The 12-phase orchestrator, agent factory, self-improvement engine, structured-output schemas, event bus, run ledger, task receipts, execution envelope, layered memory, codex-proxy, nightly runner, and dashboard are all present in `src/` as of April 22, 2026 (commit 19c663f). Tests: 776/777 passing (1 pre-existing failure = non-interactive confirm-spec timeout — see VAL-01). Typecheck + lint are clean.

**Source of truth.** `PRODUCT.md` (654 lines, commit c4b504d, April 17, 2026) is the SPEC and supersedes `PLAN.md`, `PRODUCT-REVIEW.md`, `VIBE-REVIEW.md`, and old `TODO.md`. The ingest produced 26 locked decisions (`.planning/intel/decisions.md`), 30 constraints (`.planning/intel/constraints.md`), and 21 requirements (`.planning/intel/requirements.md`) synthesized from it. Those files are the authoritative backing.

**Historical archive.** `docs/archive/` contains pre-consolidation reviews, audits, and flow analyses. Reference-only; do not treat as current.

**Skills.** Project-specific playbooks live in `.codex/skills/` and in user-level `~/.claude/projects/<slug>/memory/MEMORY.md`. The skill `autonomous-dev-phase-transition-bug` captures the historical `VALID_TRANSITIONS` silent-halt bug that CON-phase-transitions-valid now guards against.

**Backlog source.** The PRODUCT.md references `tasks-plans/tasks.md` as the active backlog, but that file is not present in the current checkout. This ROADMAP surfaces the PRODUCT.md §16 gap list directly; if `tasks-plans/tasks.md` is restored later, reconcile against it.

## Constraints

<!-- Only the load-bearing constraints are restated here. Full 30-constraint set lives in .planning/intel/constraints.md. -->

- **Runtime**: ESM modules (`"type": "module"`), internal imports use `.js` extensions even for `.ts` sources (DEC-011) — required for Node 20+ without a bundler.
- **Runtime**: Async I/O only. `execFile` (promisified); `execFileSync` forbidden (DEC-012) — prevents event-loop stalls during long-running phase work. Exception: `fs.*Sync` for small state files under `withStateLock`.
- **Runtime**: All SDK `query()` calls through `consumeQuery()` wrapper in `src/utils/sdk-helpers.ts` (DEC-015) — centralizes cost/token tracking.
- **Runtime**: SDK permission mode is `acceptEdits` for autonomous runs (DEC-010) — only mode that works under root while respecting deny-list hooks.
- **Runtime**: TypeScript strict mode enforced; CI requires `npm run typecheck` + `npm run lint` clean.
- **Runtime**: Node.js 20+ required.
- **Data**: State is immutable — `addTask`, `updateTask`, `saveCheckpoint` return new state objects (DEC-016). Persistence via atomic write under `withStateLock`.
- **Data**: `JSON.parse` results always validated via Zod `.safeParse()` (DEC-013); `as T` casts on parsed JSON forbidden. Canonical schemas in `src/types/llm-schemas.ts`.
- **Data**: JSON extraction from LLM text uses `extractFirstJson` from `src/utils/shared.ts` (CON-data-extract-first-json); no duplicates.
- **Data**: Error messages via `errMsg(err)` from `src/utils/shared.ts` (CON-data-error-message).
- **Data**: All user-derived content wrapped via `wrapUserInput(tag, content)` before prompt insertion (DEC-014; known gap in `mutation-engine.ts` tracked as SEC-02).
- **Data**: Structured output uses Zod schemas + SDK `outputFormat` in `testing`, `review`, `deployment`, `monitoring`, `development.decomposeTasks`; text fallback via `extractFirstJson` permitted.
- **Costs**: Every phase handler returns `costUsd` in `PhaseResult` from `src/phases/types.ts` (DEC-017); orchestrator accumulates into `state.totalCostUsd`.
- **Costs**: Cost source is `consumeQuery().cost` only — no alternative computation.
- **Storage**: All runtime state in `.autonomous-dev/` (not committed). Fixed substructure — `state.json`, `sessions.json`, `agents/`, `events/`, `memory/`, `receipts/`, `pending-questions.jsonl`, `dashboard.html`.
- **Storage**: Accepted mutations write `.autonomous-dev/agents/{name}.v{N}.md` and append `state.evolution[]` entry with diff + old/new scores.
- **Security**: `assertSafePath(stateDir)` blocks path traversal in `src/state/project-state.ts`; relative paths must not escape `cwd`.
- **Security**: MCP config args validated against `--eval`, `-e`, `-c`, `--require` patterns.
- **Security**: `hooks/security.ts` deny-list (`rm -rf`, `sudo`, `curl | sh`, path-traversal, credential paths) on `PreToolUse` for Bash/Read/Write/Edit (Glob/Grep/Agent/WebFetch coverage pending — SEC-05).
- **Phases**: Handlers return `PhaseResult` from `src/phases/types.ts`, not from orchestrator (CON-phase-handler-return).
- **Phases**: Transitions must come from `VALID_TRANSITIONS[currentPhase]`; returning an invalid `nextPhase` silently halts orchestrator (CON-phase-transitions-valid — historical bug guarded by skill).
- **Phases**: `staging` and `production` share a single `runDeployment` function; differentiation via `state.environment` only (DEC-004).
- **Phases**: `OPTIONAL_PHASES = ["environment-setup", "review", "ab-testing", "monitoring"]` — defined exactly once in `src/types/phases.ts` (DEC-002).
- **Memory**: Layers are L0/L2/L3/L4 only; L1 is removed as dead code (DEC-021).
- **Memory**: MemoryStore defaults — 500 documents, 100 KB per document, FIFO eviction by `updatedAt`.
- **Memory**: Per-phase injection budget `memoryStore.search(phase, { limit: 5 })`.
- **Config**: Loaded from `.autonomous-dev/config.json`, validated by Zod schema in `src/utils/config.ts`.
- **Config**: `config.rubric.enabled` defaults `false`; `config.interactive.allowAskUser` defaults `false`.
- **Config**: maxTurns defaults — development 30, testing 30, review 20, deployment 20, ideation/architecture 10, monitoring 10, decomposition 3.
- **Failure codes**: `CanonicalFailureReasonCode` is the shared union for RunLedger + SpendGovernor: `provider_limit | provider_rate_limit | invalid_structured_output | verification_failed | blocked_filesystem | unsupported_team_runtime | transient | timeout | unknown`. `TaskReceipt.failureReasonCode` is open-ended for emergent codes.

## Key Decisions

<!-- 26 locked decisions live in .planning/intel/decisions.md. The table below surfaces the highest-signal ones that most constrain ongoing work. -->

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| DEC-001: 12-phase lifecycle with VALID_TRANSITIONS | Phase-based artifact handoff is the inter-agent contract | ✓ Good — shipped and 776 tests behind it |
| DEC-002: `OPTIONAL_PHASES` single-source in `src/types/phases.ts` | Prevents `--quick` behavior drift | ✓ Good |
| DEC-004: Staging + production share `runDeployment` | Single code path for retry/rollback/structured-output | ✓ Good |
| DEC-005: Dynamic Agent Factory | Fixed rosters can't adapt to domain expertise | ✓ Good — differentiator #1 |
| DEC-006: Self-Improvement via git-worktree sandbox | Rejected mutations never contaminate working dir | ✓ Good |
| DEC-008: Self-improvement only on explicit invocation | Surprise prompt-mutation on a paid run is unacceptable | ✓ Good |
| DEC-009: Codex subagents fail-closed preflight | Silent degradation in a costly proxy loop is worse than loud fail | ✓ Good |
| DEC-010: `acceptEdits` permission mode | Only mode that works under root + respects deny-list hooks | ✓ Good |
| DEC-013: Zod `safeParse` for all JSON | Cast-based LLM-JSON parsing is the #1 crash source in agent pipelines | ✓ Good |
| DEC-014: `wrapUserInput` for all user-derived prompt content | Standardized injection mitigation | ⚠️ Revisit — gap in `mutation-engine.ts` (SEC-02) |
| DEC-015: `consumeQuery()` wrapper for all `query()` | Cost/token tracking is impossible otherwise | ✓ Good |
| DEC-016: Immutable state + atomic write under `withStateLock` | Mutating state defeats checkpoint recovery | ✓ Good |
| DEC-017: Phase handlers return `PhaseResult` with `costUsd` | Cost attribution is the basis for `--budget` enforcement | ✓ Good |
| DEC-018: Subagents over Agent Teams runtime for MVP | Token economics favor subagents until native stabilizes | ✓ Good |
| DEC-021: L1 memory layer removed | Dead code with no consumers | ✓ Good |
| DEC-022: `TaskReceipt.status === "success"` is the only completion signal | Text-heuristic success was the #1 false-positive source | ✓ Good |
| DEC-023: Unified `CanonicalFailureReasonCode` for Ledger + SpendGovernor | Divergent enums made root-cause analysis impossible | ✓ Good |
| DEC-024: Rubric evaluation is the only semantic `acceptance_criteria_met` check | Deterministic linters can't verify semantic acceptance | ✓ Good (with HIGH-01 gap) |
| DEC-025: ExecutionEnvelope is environment config, not agent config | Re-detecting env per agent prompt was a measurable cost line | ✓ Good |
| DEC-026: Package manager precedence `bun > pnpm > yarn > npm` | Stable precedence eliminates lockfile ambiguity | ✓ Good |

---
*Last updated: 2026-04-22 after ingest-driven `.planning/` bootstrap (SPEC source: `PRODUCT.md` commit c4b504d; intel synthesis in `.planning/intel/`).*
