# Context

Project background, mission, and topical notes synthesized from `PRODUCT.md` (SPEC, precedence 0) and `README.md` (DOC, precedence 3).

Source of truth for any disagreement: `PRODUCT.md` (commit c4b504d, April 17, 2026).

---

## Mission

> Self-improving multi-agent development system on top of the Claude Agent SDK. Takes a product idea and autonomously runs it through the full lifecycle: specification → architecture → environment setup → implementation → testing → review → staging → A/B → production → monitoring. In parallel the system **improves itself** — benchmarks evaluate agents, hill-climbing mutates their prompts, effective patterns crystallize into skills, failures are deposited in layered memory.

Source: `PRODUCT.md` §1.

---

## What the system is

- A **backend orchestrator** for autonomous product development.
- A **Claude Agent SDK** application written in TypeScript (ESM, Node 20+).
- A **phase-state machine** with 12 phases, 4 of which are optional.
- A **factory + registry** of dynamically generated, domain-specific agents.
- A **self-improvement engine** that mutates agent prompts in git worktree sandboxes and accepts only score-improving changes.

## What the system explicitly is NOT (PRODUCT.md §1)

- Not a vibe-coding UI / IDE. Real-time streaming and dashboards are intentionally limited (the dashboard is a static HTML snapshot).
- Not opaque on cost. Spend is exposed via `consumeQuery().cost` and gated by `--budget`; the operator owns the budget decision.
- Not a human replacement on critical-path decisions. Operator-in-the-loop gates: `--confirm-spec`, L0 meta-rules, `ask-user` hook (off by default but enableable).

---

## Four key differentiators

Source: `PRODUCT.md` §1.

1. **Agent Factory — dynamic agent creation per domain.** Instead of a fixed PM/Dev/QA roster, the system analyzes the idea, classifies the domain (fintech/trading, healthcare, data/ML, productivity/AI-email, etc.), and generates blueprints for specialized agents with hard constraints and concrete domain expertise.
2. **Stack Researcher — environment auto-configuration.** After the `architecture` phase, the system identifies the stack and discovers/installs optimal LSP servers, MCP servers, plugins, and OSS tools matched to the stack.
3. **Self-Improvement Loop (AutoAgent-style).** Benchmark-driven hill-climbing: prompt/tool-config/phase-logic mutations → run in git worktree sandbox → accept/reject by score.
4. **Continuous Product Improvement.** Post-deployment loop: production metrics → hypothesis → A/B experiment → rollout/rollback → learning.

---

## Top-level architecture

Source: `PRODUCT.md` §2.

```
CLI (src/index.ts, commander)
  run / status / phase / optimize / nightly / dashboard
    │
    ▼
Orchestrator (src/orchestrator.ts)
  phase loop + retry + checkpoint + SIGINT-safe + EventBus + Ledger
    │
    ├─► Phases (12)
    ├─► Agents (factory + registry + domain-analyzer)
    └─► Environment (stack-researcher + LSP/MCP/plugin + OSS scanner)
    │
    ▼
Cross-cutting infrastructure:
  events/ evaluation/ hooks/ memory/ state/ governance/
  runtime/ self-improve/ nightly/ dashboard/
```

**Data movement rule:** Each phase returns a `PhaseResult` from `src/phases/types.ts` containing `success`, `state`, `nextPhase?`, `costUsd`, `durationMs`, `rubricResult?`. State serializes to `.autonomous-dev/state.json` via immutable updates + atomic write under `withStateLock`. Events flow through `EventBus` → `EventLogger` to JSONL at `.autonomous-dev/events/{runId}.jsonl`. The Run Ledger captures topology and per-session/role spend.

---

## Repository layout (high level)

Source: `PRODUCT.md` §14.

- `src/index.ts` — CLI entry point (commander).
- `src/orchestrator.ts` — phase loop with retry + checkpoints.
- `src/phases/` — per-phase handlers + dev-runner + types.
- `src/agents/` — factory, registry, domain-analyzer, stack-researcher, codex-proxy, base-blueprints.
- `src/environment/` — LSP/MCP/plugin managers, OSS scanner, CLAUDE.md generator, validator.
- `src/self-improve/` — optimizer, mutation engine, benchmarks, sandbox, verifiers, convergence, versioning.
- `src/evaluation/` — rubrics + grader + evaluate-loop.
- `src/events/` — event-bus, event-logger, interrupter.
- `src/hooks/` — quality-gate, security, idle-handler, audit-logger, notifications, improvement-tracker, memory-capture.
- `src/state/` — project-state, session-store, memory-store, run-ledger.
- `src/memory/` — layers (L0/L2/L4), skills (L3), meta-rules.
- `src/governance/` — spend-governor.
- `src/runtime/` — ask-user, codex-preflight, execution-envelope.
- `src/types/` — llm-schemas, phases (incl. `OPTIONAL_PHASES`), failure-codes, task-receipt.
- `src/utils/` — shared, config, retry, sdk-helpers, progress, type-guards.

Runtime state in `.autonomous-dev/` (not committed). Tests in `tests/` (vitest).

---

## Status snapshot (April 17, 2026)

Source: `PRODUCT.md` §16.

**End-to-end working:**

- 12-phase pipeline with transitions, checkpoint recovery, SIGINT-safe shutdown, `--resume`.
- Dynamic Agent Factory + Domain Analyzer.
- Stack Researcher (LSP/MCP/plugin/OSS discovery).
- Self-improvement loop with hill-climbing + sandbox + versioning.
- Structured output via Zod in testing/review/deployment/monitoring/task-decomposition.
- EventBus + EventLogger + Interrupter.
- Run Ledger, spend governor, task receipts, execution envelope.
- L0/L2/L3/L4 LayeredMemory + SkillStore + MemoryStore + memory-capture function.
- Codex-proxy with fail-closed preflight.
- Nightly runner + static-HTML dashboard generator.
- Rubric evaluation (profile-gated, off by default).
- Ask-user hook (journal mode by default).
- Unified `FailureReasonCode` (9 values) via `src/types/failure-codes.ts`.
- `OPTIONAL_PHASES` (single source).
- 777 tests (vitest), 79 test files, clean typecheck + lint.

**Known product gaps (per `PRODUCT.md` §16):**

- No real-time web UI / streaming dashboard.
- No real-time stdout streaming of LLM output.
- No `init` guided-setup command.
- A/B testing phase is conceptual; PostHog integration not real.
- Cloud deploy integration is partial.
- No template/starter system; always builds from-scratch from idea string.

**Known critical/security backlog items (PRODUCT.md §16):**

- SDK CVE downgrade for `@anthropic-ai/claude-agent-sdk@0.2.90`.
- Sandbox executable allowlist.
- `wrapUserInput` coverage in `mutation-engine.ts`.
- LSP install command-injection allowlist.
- Security hook coverage for Glob/Grep/Agent/WebFetch.
- ReDoS in `memory-store.ts` topic regex.
- Path traversal hardening in state dirs.

**Known high-priority backlog items (PRODUCT.md §16):**

- Rubric feedback loop wiring in orchestrator.
- Grader overwriting LLM verdict.
- Stale Interrupter singleton race.
- Specification phase stub + circular import.
- Unverified blueprints in `optimizer-runner.ts`.
- Domain-agent ↔ task keyword matching.
- API key removal from `Config` object.

---

## Architectural commits (locked in code)

Source: `PRODUCT.md` §16.

- **Subagents over Agent Teams runtime for MVP.** Native Agent Teams runtime is a future goal; partial migration plan is in `docs/archive/2026-04-10-agent-teams-native-execution-plan.md`.
- **Git worktrees for isolation.** Used by mutation sandbox and parallel dev agents.
- **Validate before install.** LSP/MCP/plugin pass through compatibility + security + benchmark checks; auto-rollback on regression.
- **`acceptEdits` permission mode.** `bypassPermissions` rejected (blocked under root); `dontAsk` respects `ask`-rules.
- **Three feedback loops.** Product loop (metrics → hypothesis → experiment), meta loop (benchmark → mutation → accept/reject), environment loop (efficiency → discover tools → validate → install).

---

## Authentication and prerequisites

Source: `README.md` Quickstart + `PRODUCT.md` §13 (Env vars).

- Node.js 20+.
- Claude Code subscription (Pro, Max, or Team) — authentication is automatic via the Claude Code CLI; no `ANTHROPIC_API_KEY` required.
- Optional env vars: `GITHUB_TOKEN`, `SLACK_WEBHOOK_URL`, `POSTHOG_API_KEY`.

---

## Source-doc cross-references

| Topic | PRODUCT.md section | README.md section |
|-------|--------------------|-------------------|
| Mission and concept | §1 | "How It Works" |
| Architecture overview | §2 | "Architecture" |
| 12-phase lifecycle | §3 | "How It Works" diagram |
| Agent Factory | §4 | "Key features" bullet 2 |
| Self-Improvement Loop | §5 | "Self-Improvement Engine" |
| Stack Researcher | §6 | "Key features" bullet 4 |
| Observability (EventBus) | §7 | (not detailed) |
| Memory layers | §8 | (not detailed) |
| Rubric evaluation | §9 | "Status" mention |
| Hooks and security | §10 | (architecture file list) |
| Governance | §11 | (`--budget` flag) |
| Execution envelope | §12 | (architecture file list) |
| CLI and config | §13 | "Quickstart" + "Commands" |
| Repository layout | §14 | "Architecture" tree |
| Invariants | §15 | (implicit) |
| Status | §16 | "Status" |

---

## Cross-references and historical archive

Per `PRODUCT.md` §17, historical context lives in `docs/archive/`:

- `PLAN.md` — original vision (concept-to-implementation bridge).
- `PRODUCT-REVIEW.md`, `VIBE-REVIEW.md` — PM/UX reviews from April 8.
- `TODO.md` — old tracker (replaced by `tasks-plans/tasks.md` + `PRODUCT.md`).
- `audit-report-2026-04-08.md`, `typescript-audit-2026-04-09.md` — code audits.
- `product-execution-flow.md`, `flow-analysis-recommendations.md`, `test-run-analysis.md` — live-run analyses.
- `2026-04-10-agent-teams-native-execution-plan.md` — partial native team runtime plan.
- `2026-04-10-telegram-oi-*.md` — E2E findings + frontend interface spec (reference-only).
- `2026-04-10-autonomy-test-hardening.md` — completed test plan.

External docs: [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-agent-sdk), [Claude Code](https://claude.ai/code).
