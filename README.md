# Autonomous Dev System

Self-improving multi-agent development system built on [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-agent-sdk). Give it an idea — it designs, builds, tests, and deploys autonomously, then optimizes its own agent prompts via hill-climbing.

> **Product documentation** — for goals, architecture deep-dive, 12-phase lifecycle details, memory/governance/self-improve mechanics, and current implementation status, see [`PRODUCT.md`](./PRODUCT.md).
> **Active backlog** — [`tasks-plans/tasks.md`](./tasks-plans/tasks.md).
> **Historical reviews and plans** — [`docs/archive/`](./docs/archive/).

## How It Works

The system runs your project through a phased lifecycle, each handled by specialized AI agents:

```
idea → ideation → specification → architecture → environment-setup
    → development → testing → review → staging → ab-testing → analysis
    → production → monitoring
```

**Key features:**
- **Phase-based orchestration** — each phase produces artifacts consumed by the next
- **Dynamic agent factory** — creates domain-specific agents on the fly (e.g., a "quant researcher" for fintech projects)
- **Codex-backed subagents** — Opus can keep orchestrating ordinary subagents while the actual implementation work is delegated to `codex exec` on `gpt-5.4` with `xhigh` reasoning
- **Stack auto-discovery** — detects your tech stack and configures LSP servers, MCP servers, and Claude Code plugins automatically
- **Self-improvement engine** — benchmarks agent performance and evolves prompts via mutation + hill-climbing optimization
- **Git worktree sandbox** — evaluates mutations in isolated worktrees so your working directory stays clean
- **Checkpoint recovery** — state persisted to disk after each phase, resume any time

## Quickstart

### Prerequisites

- Node.js 20+
- [Claude Code](https://claude.ai/code) subscription (Pro, Max, or Team) — authentication happens automatically through the Claude Code CLI; no separate `ANTHROPIC_API_KEY` needed

### Install

```bash
git clone https://github.com/aerbaser/autonomous-dev-system.git
cd autonomous-dev-system
npm install
npm run build
```

### Run

```bash
npx autonomous-dev run --idea "Build a real-time collaborative todo app with WebSocket sync"

# With budget cap (stops when cost exceeds $10)
npx autonomous-dev run --idea "..." --budget 10

# Preview what would happen without spending API credits
npx autonomous-dev run --idea "..." --dry-run

# Skip optional phases (env-setup, review, ab-testing) for faster iteration
npx autonomous-dev run --idea "..." --quick

# Pause after spec generation for user confirmation before continuing
npx autonomous-dev run --idea "..." --confirm-spec

# Resume a previously interrupted project
npx autonomous-dev run --idea "..." --resume <session-id>

# Check project status
npx autonomous-dev status

# Run a specific phase
npx autonomous-dev phase --name testing

# Run self-improvement optimization
npx autonomous-dev optimize --max-iterations 10

# Run unattended nightly maintenance
npx autonomous-dev nightly --max-iterations 3
```

### Development mode (no build step)

```bash
# Uses tsx for direct TypeScript execution
npm run dev -- run --idea "Build a CLI tool for managing bookmarks"
```

### Configuration

The system looks for config in `.autonomous-dev/config.json`, or you can pass `--config path/to/config.json`:

```json
{
  "model": "claude-opus-4-6",
  "subagentModel": "claude-sonnet-4-6",
  "projectDir": ".",
  "stateDir": ".autonomous-dev",
  "codexSubagents": {
    "enabled": true,
    "model": "gpt-5.4",
    "reasoningEffort": "xhigh",
    "sandbox": "workspace-write",
    "approvalPolicy": "on-request"
  },
  "selfImprove": {
    "enabled": true,
    "maxIterations": 50
  },
  "deployTarget": {
    "provider": "vercel",
    "config": {}
  }
}
```

When `codexSubagents.enabled=true`, the development orchestrator still delegates to normal-looking subagents through Opus, but each subagent becomes a thin proxy that forwards its assignment to `codex exec` and reports the result back upstream.

Environment variables (all optional):
- `GITHUB_TOKEN` — for GitHub integrations
- `SLACK_WEBHOOK_URL` — for Slack notifications
- `POSTHOG_API_KEY` — for analytics
- `AUTONOMOUS_DEV_LEAD_DRIVEN` — set to `1` to enable v1.1 super-lead mode (see below)

### Super-lead mode (v1.1)

`AUTONOMOUS_DEV_LEAD_DRIVEN=1` switches four decision-bearing phases — `specification`, `architecture`, `testing`, `review` — from single `query()` calls to a lead + specialists team invoked via the Agent tool. Each phase gets two phase-scoped specialists (e.g. architecture runs with `security-reviewer` + `scalability-reviewer`; testing runs with `edge-case-finder` + `property-tester`). Specialists never receive the Agent tool themselves. Backloops are capped per-contract and an orchestrator-level livelock guard halts the run after 5 repeats of the same `(from → to)` pair.

Default is OFF — the existing single-query paths are unchanged.

```bash
AUTONOMOUS_DEV_LEAD_DRIVEN=1 npx autonomous-dev run --idea "..."
```

See [`PRODUCT.md` §3.1](./PRODUCT.md) for the full architecture.

> Authentication is handled automatically by the Claude Code CLI subscription — no `ANTHROPIC_API_KEY` is needed.

## Architecture

```
src/
├── index.ts                  # CLI entry point (commander)
├── orchestrator.ts           # Main phase loop with retry + checkpoints
├── phases/                   # Phase handlers (one per lifecycle stage)
│   ├── types.ts              # PhaseResult, PhaseHandler types
│   ├── ideation.ts           # Idea → structured spec
│   ├── architecture.ts       # Spec → tech stack + architecture design
│   ├── environment-setup.ts  # Auto-configure LSP, MCP, plugins (parallel)
│   ├── development.ts        # Facade → development-runner
│   ├── development-runner.ts # Task decomposition → parallel dev agents
│   ├── development-types.ts  # Development phase types
│   ├── testing.ts            # Structured output: TestingResultSchema
│   ├── review.ts             # Structured output: ReviewResultSchema
│   ├── deployment.ts         # Structured output: DeploymentResultSchema
│   ├── ab-testing.ts         # A/B test design + analysis
│   └── monitoring.ts         # Structured output: MonitoringResultSchema
├── agents/                   # Agent management
│   ├── base-blueprints.ts    # 7 base agents + getBaseAgentNames()
│   ├── codex-proxy.ts        # Wraps normal subagents so Opus can delegate into Codex CLI
│   ├── factory.ts            # Dynamic domain-specific agent creation
│   ├── registry.ts           # Blueprint storage + performance tracking
│   ├── domain-analyzer.ts    # Domain classification via LLM
│   └── stack-researcher.ts   # Tech stack analysis via LLM
├── self-improve/             # Self-improvement engine
│   ├── optimizer.ts          # Main optimization loop (facade)
│   ├── optimizer-runner.ts   # Hill-climbing implementation
│   ├── mutation-engine.ts    # Prompt/config mutation strategies
│   ├── benchmarks.ts         # Benchmark suite runner
│   ├── convergence.ts        # Stagnation/plateau detection
│   ├── sandbox.ts            # Process + git worktree isolation
│   ├── verifiers.ts          # Deterministic + LLM-judged verification
│   └── versioning.ts         # Prompt version history
├── environment/              # Stack discovery + configuration
│   ├── lsp-manager.ts        # LSP server install (async)
│   ├── mcp-manager.ts        # MCP server configuration
│   ├── plugin-manager.ts     # Plugin install (async)
│   ├── oss-scanner.ts        # Open-source tool scanner
│   ├── claude-md-generator.ts # CLAUDE.md generation
│   └── validator.ts          # Input validation for LSP/MCP/plugins
├── events/                   # Structured event system
│   ├── event-bus.ts          # Typed EventBus with onAll subscriber
│   ├── event-logger.ts       # Persists events to JSONL per run
│   └── interrupter.ts        # Graceful shutdown coordination
├── evaluation/               # Rubric-based quality evaluation
│   ├── rubric.ts             # Rubric + RubricResult types
│   ├── phase-rubrics.ts      # Per-phase rubric definitions
│   ├── grader.ts             # LLM-judged grading of phase output
│   └── evaluate-loop.ts      # Re-run handler until rubric satisfied
├── hooks/                    # Claude Code hook handlers
│   ├── quality-gate.ts       # Lint check on TaskCompleted (async)
│   ├── security.ts           # Command/path deny-list enforcement
│   ├── idle-handler.ts       # Idle agent management
│   ├── audit-logger.ts       # Operation audit trail (JSONL)
│   ├── notifications.ts      # Slack/webhook alerts
│   ├── improvement-tracker.ts # Tool usage metrics (TTL-evicted)
│   └── memory-capture.ts     # Extracts learnings from phase results into MemoryStore
├── state/                    # Persistent state management
│   ├── project-state.ts      # Immutable state, ALL_PHASES, phase transitions
│   ├── session-store.ts      # Session persistence
│   ├── memory-store.ts       # Cross-session knowledge store (search, upsert, evict)
│   └── memory-types.ts       # MemoryDocument, MemoryIndex Zod schemas
├── types/
│   └── llm-schemas.ts        # Zod schemas for all JSON parsing + structured output
└── utils/                    # Shared utilities
    ├── shared.ts             # extractFirstJson, isApiRetry, isRecord, errMsg, wrapUserInput
    ├── config.ts             # Zod-validated config loading
    ├── retry.ts              # Exponential backoff retry
    ├── sdk-helpers.ts        # consumeQuery, getQueryPermissions, getMaxTurns
    ├── progress.ts           # Typed EventEmitter for phase progress
    └── templates.ts          # Prompt templates

benchmarks/                   # External benchmark definitions
├── code-quality/tasks.json
├── test-generation/tasks.json
├── spec-completeness/tasks.json
├── architecture-quality/tasks.json
└── domain-specific/README.md

tests/                        # 881 tests across 87 files
```

## Commands

| Command | Description |
|---------|-------------|
| `autonomous-dev run --idea "..."` | Start autonomous development |
| `autonomous-dev run ... --budget <usd>` | Cap total API spend |
| `autonomous-dev run ... --dry-run` | Preview phases without spending credits |
| `autonomous-dev run ... --quick` | Skip optional phases (env-setup, review, ab-testing) |
| `autonomous-dev run ... --confirm-spec` | Pause for approval after spec generation |
| `autonomous-dev run ... --resume <id>` | Resume from checkpoint |
| `autonomous-dev status` | Show project state |
| `autonomous-dev phase --name <phase>` | Run specific phase |
| `autonomous-dev optimize` | Run self-improvement loop |
| `autonomous-dev nightly` | Run unattended nightly optimize/dashboard maintenance |

## Scripts

```bash
npm run build       # Compile TypeScript
npm run dev         # Run with tsx (no build)
npm run nightly     # Run unattended nightly maintenance
npm run test        # Run all tests
npm run test:watch  # Watch mode
npm run typecheck   # Type checking
npm run lint        # ESLint
```

## Self-Improvement Engine

The optimizer evolves agent prompts through a benchmark-driven loop:

1. **Benchmark** current agent performance (code quality, test generation, spec completeness, architecture, build success)
2. **Mutate** the worst-performing agent's prompt/config
3. **Evaluate** the mutation (optionally in an isolated git worktree)
4. **Accept** if score improved, **rollback** if not
5. **Repeat** until convergence (stagnation or plateau detected)

Custom benchmarks can be added to `benchmarks/<category>/tasks.json`.

## Status

All 12 phases implemented, input sanitization via XML delimiters, full Zod schema validation, cost tracking across all phases, ESLint enforced in CI. Event bus emits typed events per phase/agent/memory operation. Rubric-based evaluation loop re-runs phases until quality bar is met. Persistent cross-session memory (L0–L4 layered memory + SkillStore + MemoryStore). Run ledger, spend governor, and task receipts enforce attributable, bounded execution. Opt-in v1.1 super-lead agent-team mode for 4 decision-bearing phases (`AUTONOMOUS_DEV_LEAD_DRIVEN=1`). 881 tests.

For the full status matrix and open work, see [`PRODUCT.md`](./PRODUCT.md) and [`tasks-plans/tasks.md`](./tasks-plans/tasks.md).

## License

MIT
