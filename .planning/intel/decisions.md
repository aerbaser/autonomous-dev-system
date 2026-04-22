# Decisions

Locked architectural decisions extracted from `PRODUCT.md` (SPEC, precedence 0). These are the design invariants for the Autonomous Dev System and cannot be auto-overridden by lower-precedence sources.

Source of truth: `/Users/admin/Desktop/AI/Web2/autonomous-dev-system/PRODUCT.md` (commit c4b504d, April 17, 2026).

---

## DEC-001: 12-phase lifecycle is the spine of the orchestrator

- **Status:** locked
- **Source:** `PRODUCT.md` §3
- **Decision:** Every project run flows through `ALL_PHASES` (defined in `src/types/phases.ts`) in order: `ideation → specification → architecture → environment-setup → development → testing → review → staging → ab-testing → analysis → production → monitoring`. Transitions are gated by `VALID_TRANSITIONS`; arbitrary phase jumps are not allowed.
- **Scope:** orchestrator phase loop, phase handlers, state machine
- **Rationale:** Phase-based artifact handoff is the contract that makes downstream agents able to consume upstream output without re-derivation.

## DEC-002: `OPTIONAL_PHASES` lives in a single source

- **Status:** locked
- **Source:** `PRODUCT.md` §3
- **Decision:** `OPTIONAL_PHASES = ["environment-setup", "review", "ab-testing", "monitoring"]` is defined exactly once in `src/types/phases.ts` and imported by both `orchestrator.ts` and `index.ts`. `--quick` mode skips these phases via quick-skip logic (handler not invoked, `transitionPhase` to next phase).
- **Scope:** quick-mode behavior, CLI flags, orchestrator skip logic
- **Rationale:** Duplicate phase definitions historically caused drift between `--quick` behavior and CLI help text.

## DEC-003: Cyclic phase transitions allowed for re-implementation

- **Status:** locked
- **Source:** `PRODUCT.md` §3
- **Decision:** `VALID_TRANSITIONS` permits `testing ↔ development`, `review ↔ development`, `analysis ↔ development`, `monitoring → development` so that failing rubric verdicts or failing tests can route back to development for fix-up.
- **Scope:** state machine transitions in `src/state/project-state.ts`
- **Rationale:** Without back-edges the pipeline cannot self-correct without operator intervention.

## DEC-004: Staging and production share one deployment function

- **Status:** locked
- **Source:** `PRODUCT.md` §3
- **Decision:** Phases 8 (`staging`) and 11 (`production`) both invoke a common `runDeployment` function. The differentiation is via the `environment` field in state, NOT via a separate handler.
- **Scope:** `src/phases/deployment.ts` (single implementation)
- **Rationale:** Single deployment code path eliminates divergence in retry, rollback, and structured-output handling.

## DEC-005: Agent Factory generates domain-specific agents dynamically

- **Status:** locked
- **Source:** `PRODUCT.md` §4 (Agent Factory)
- **Decision:** The system does NOT use a fixed agent roster. `src/agents/domain-analyzer.ts::analyzeDomain()` classifies each idea, then `src/agents/factory.ts::buildAgentTeam()` idempotently generates `AgentBlueprint[]` for the domain. 7 base agents (`product-manager`, `architect`, `developer`, `qa-engineer`, `reviewer`, `devops`, `analytics`) are always present; domain agents are layered on top.
- **Scope:** agent team construction, blueprint persistence
- **Rationale:** Dynamic specialization is one of the four key differentiators; fixed rosters cannot adapt to domain-specific expertise needs.

## DEC-006: Self-Improvement Loop uses hill-climbing in git worktree sandbox

- **Status:** locked
- **Source:** `PRODUCT.md` §5 (Self-Improvement Loop)
- **Decision:** Mutations are evaluated in isolated git worktrees via `src/self-improve/sandbox.ts`. Each mutation is accept/reject by score delta against the baseline benchmark suite. Accepted mutations produce `{agentName}.v{N}.md` versioned blueprints + `state.evolution[]` entries.
- **Scope:** `src/self-improve/` (8 files)
- **Rationale:** Worktree isolation guarantees that rejected mutations never contaminate the working directory.

## DEC-007: Mutation type selection is weighted by recent success history

- **Status:** locked
- **Source:** `PRODUCT.md` §5 (Self-Improvement Loop)
- **Decision:** `selectMutationType(history)` uses weighted selection over the last 20 mutations rather than naive round-robin. Successful mutation types are reinforced.
- **Scope:** `src/self-improve/mutation-engine.ts`
- **Rationale:** Round-robin wastes iterations on consistently-failing mutation types.

## DEC-008: Self-improvement runs only on explicit invocation, never auto-pipeline

- **Status:** locked
- **Source:** `PRODUCT.md` §5 (Self-Improvement Loop)
- **Decision:** The optimizer triggers via `autonomous-dev optimize`, `autonomous-dev nightly`, or via the nightly cron — never automatically as part of a pipeline run. This is an explicit "do not optimize without permission" architectural choice.
- **Scope:** orchestrator behavior, optimizer entrypoints
- **Rationale:** Surprise self-modification of agent prompts during a paid run is unacceptable.

## DEC-009: Codex-backed subagents are opt-in with fail-closed preflight

- **Status:** locked
- **Source:** `PRODUCT.md` §4 (Codex-backed subagents)
- **Decision:** When `config.codexSubagents.enabled = true`, Opus remains the team lead while implementation is delegated to `codex exec` on `gpt-5.4` with `xhigh` reasoning. On run start, `src/runtime/codex-preflight.ts` probes `codex --version`; if the binary is missing, throws `UnsupportedTeamRuntimeError`. Preflight is skipped during nightly runs via `NIGHTLY_ENV_FLAG`.
- **Scope:** runtime preflight, codex-proxy wrapper
- **Rationale:** Silent degradation into a costly proxy loop with a missing binary is worse than failing loudly.

## DEC-010: Permission mode is `acceptEdits` for autonomous runs

- **Status:** locked
- **Source:** `PRODUCT.md` §15 (Runtime invariants)
- **Decision:** Autonomous orchestrator runs use SDK permission mode `acceptEdits`. Historically `bypassPermissions` was used but it is blocked under root; `dontAsk` respects `ask`-rules, `bypassPermissions` bypasses them.
- **Scope:** orchestrator + SDK query options
- **Rationale:** `acceptEdits` is the only mode that works for autonomous runs across both root and non-root environments while still respecting deny-list hooks.

## DEC-011: ESM modules with `.js`-suffixed import paths

- **Status:** locked
- **Source:** `PRODUCT.md` §15 (Runtime invariants)
- **Decision:** Project is `"type": "module"`; all internal imports use `.js` extensions even though source files are `.ts` (TypeScript resolves them at build time).
- **Scope:** project-wide
- **Rationale:** Required for Node 16+ ESM compatibility without bundler.

## DEC-012: Async-only I/O; `execFile` over `execFileSync`

- **Status:** locked
- **Source:** `PRODUCT.md` §15 (Runtime invariants)
- **Decision:** All process invocations use promisified `execFile`. `execFileSync` is forbidden. Exception: `fs.*Sync` calls are allowed for small state files when wrapped in `withStateLock`.
- **Scope:** project-wide
- **Rationale:** Sync I/O blocks the event loop and causes orchestrator stalls during long-running operations.

## DEC-013: All `JSON.parse` results validated through Zod `safeParse`

- **Status:** locked
- **Source:** `PRODUCT.md` §15 (Data and validation)
- **Decision:** No `as T` casts on parsed JSON. Canonical Zod schemas live in `src/types/llm-schemas.ts`. JSON extraction from LLM text uses `extractFirstJson` from `src/utils/shared.ts` (never duplicated).
- **Scope:** project-wide JSON handling
- **Rationale:** Cast-based parsing of LLM output is the single largest source of runtime crashes in agent pipelines.

## DEC-014: User-derived input must be wrapped via `wrapUserInput`

- **Status:** locked
- **Source:** `PRODUCT.md` §15 (Data and validation)
- **Decision:** All user-derived strings (idea text, fixed-string excerpts, etc.) are wrapped with `wrapUserInput(tag, content)` from `src/utils/shared.ts`, which inserts XML delimiters. This must apply everywhere, including `mutation-engine.ts` (currently in backlog as a known gap).
- **Scope:** prompt assembly across all phases
- **Rationale:** XML-delimited untrusted content is the project's standardized prompt-injection mitigation.

## DEC-015: All `query()` calls use `consumeQuery()` wrapper

- **Status:** locked
- **Source:** `PRODUCT.md` §15 (Runtime invariants)
- **Decision:** Direct `query()` from `@anthropic-ai/claude-agent-sdk` is wrapped via `consumeQuery()` in `src/utils/sdk-helpers.ts`. The wrapper returns `{result, cost, modelUsage, inputTokens, outputTokens, cacheTokens}`.
- **Scope:** every agent invocation
- **Rationale:** Centralized cost/token tracking is impossible if `query()` is called directly.

## DEC-016: State updates are immutable; `saveState` is atomic with file lock

- **Status:** locked
- **Source:** `PRODUCT.md` §15 (Data and validation)
- **Decision:** `addTask`, `updateTask`, `saveCheckpoint` return new state objects. Persistence to `.autonomous-dev/state.json` uses atomic write under `withStateLock`.
- **Scope:** `src/state/project-state.ts`, all phase handlers
- **Rationale:** Mutating state in place defeats checkpoint recovery and concurrent-phase safety.

## DEC-017: Each phase handler returns `PhaseResult` with `costUsd`

- **Status:** locked
- **Source:** `PRODUCT.md` §15 (Costs)
- **Decision:** Phase handlers return `PhaseResult` from `src/phases/types.ts` (NOT from orchestrator). `costUsd` is mandatory; the orchestrator accumulates it into `state.totalCostUsd`.
- **Scope:** every phase handler
- **Rationale:** Cost attribution per phase is the basis for `--budget` enforcement and post-run analysis.

## DEC-018: Subagents over Agent Teams runtime for MVP

- **Status:** locked
- **Source:** `PRODUCT.md` §16 (Architectural commits)
- **Decision:** The current implementation uses subagents (cheaper in tokens) instead of native Agent Teams runtime. Agent Teams native runtime is a future goal; the migration plan (`docs/archive/2026-04-10-agent-teams-native-execution-plan.md`) is partially executed (Phases 1, 4, 6, 7, 10 done; remainder backlogged).
- **Scope:** orchestrator delegation pattern
- **Rationale:** Token economics favor subagents until native runtime stabilizes.

## DEC-019: Validate before install (LSP/MCP/plugin)

- **Status:** locked
- **Source:** `PRODUCT.md` §16 (Architectural commits)
- **Decision:** Every LSP, MCP server, or plugin install passes through `src/environment/validator.ts`: compatibility check → security scan → benchmark before/after (when self-improve loop active) → automatic rollback if score regresses.
- **Scope:** environment-setup phase, validator module
- **Rationale:** Auto-installed tools that degrade agent quality must be reversible without operator intervention.

## DEC-020: Three feedback loops as the system's learning architecture

- **Status:** locked
- **Source:** `PRODUCT.md` §16 (Architectural commits)
- **Decision:** The system runs three distinct feedback loops:
  1. **Product loop** — production metrics → hypothesis → A/B experiment → rollout/rollback.
  2. **Meta loop** — benchmark → mutation → accept/reject of agent prompts.
  3. **Environment loop** — efficiency signal (e.g., excessive grep) → discover tools → validate → install.
- **Scope:** self-improve, environment, ab-testing/analysis phases
- **Rationale:** Each loop closes a different category of capability gap.

## DEC-021: L1 memory layer is removed; layered memory is L0/L2/L3/L4

- **Status:** locked
- **Source:** `PRODUCT.md` §8 (Memory)
- **Decision:** The previous L1 layer was removed as dead code (no consumers). Active layers are L0 (meta-rules, in-repo), L2 (global facts, e.g. stack environment), L3 (skill playbooks via `SkillStore`), and L4 (session archive, JSONL). L2 facts are persisted but not yet injected into phase prompts (TODO).
- **Scope:** `src/memory/layers.ts`, `src/memory/skills.ts`
- **Rationale:** Dead code in memory layers caused confusion in producer/consumer mapping.

## DEC-022: TaskReceipt is the only signal of task completion

- **Status:** locked
- **Source:** `PRODUCT.md` §10 (Task Receipts)
- **Decision:** A task is "done" only when a structured `TaskReceipt` validates against `TaskReceiptSchema.safeParse()` AND `receipt.status === "success"`. LLM text saying "done" never flips status. `freeformNotes` is debug-only and does not influence completion.
- **Scope:** `src/types/task-receipt.ts`, development-runner
- **Rationale:** Text-heuristic success was the largest source of false-positive task completions in earlier phases.

## DEC-023: Unified `FailureReasonCode` across RunLedger and SpendGovernor

- **Status:** locked
- **Source:** `PRODUCT.md` §7 (Run Ledger)
- **Decision:** `src/types/failure-codes.ts::CanonicalFailureReasonCode` is the superset of failure codes shared by RunLedger and SpendGovernor (alias). Set: `provider_limit | provider_rate_limit | invalid_structured_output | verification_failed | blocked_filesystem | unsupported_team_runtime | transient | timeout | unknown`. `TaskReceipt.failureReasonCode` is open-ended (`z.union([enum, z.string()])`) for forward compatibility.
- **Scope:** failure attribution and retry logic
- **Rationale:** Divergent failure-code enums between modules made root-cause analysis impossible.

## DEC-024: `acceptance_criteria_met` requires rubric evaluation

- **Status:** locked
- **Source:** `PRODUCT.md` §9 (Rubric Evaluation)
- **Decision:** Rubric evaluation is the only path that semantically checks `acceptance_criteria_met` for a phase. Quality-gate hooks cover only deterministic checks (lint, tsc, vitest). Rubrics are profile-gated via `config.rubric.enabled` (off by default for cost reasons).
- **Scope:** evaluation module, quality gate hook
- **Rationale:** Acceptance criteria are inherently semantic and cannot be verified by deterministic linters alone.

## DEC-025: ExecutionEnvelope is environment config, not agent config

- **Status:** locked
- **Source:** `PRODUCT.md` §12 (Runtime: execution envelope)
- **Decision:** `buildEnvelope()` in `src/runtime/execution-envelope.ts` produces a validated runtime context (`projectRoot`, `writableRoot`, `branch`, `packageRoot?`, `allowedVerificationCommands[]`, `environment`). This envelope is inlined as XML into every delegated task prompt, so agents do not waste tokens detecting paths, package manager, or branch.
- **Scope:** every delegated task across all phases
- **Rationale:** Repeating environment detection in every agent prompt was a measurable cost line item.

## DEC-026: Package manager detected by lockfile precedence `bun > pnpm > yarn > npm`

- **Status:** locked
- **Source:** `PRODUCT.md` §12 (Runtime: execution envelope)
- **Decision:** `detectPackageManager(projectRoot)` walks lockfiles in precedence `bun.lockb > pnpm-lock.yaml > yarn.lock > package-lock.json` and returns `"bun" | "pnpm" | "yarn" | "npm" | "unknown"`.
- **Scope:** envelope construction
- **Rationale:** Stable precedence eliminates ambiguity when multiple lockfiles coexist.
