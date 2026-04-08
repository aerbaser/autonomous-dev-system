# Autonomous Dev System

Self-improving multi-agent development system built on [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-agent-sdk). Give it an idea — it designs, builds, tests, and deploys autonomously, then optimizes its own agent prompts via hill-climbing.

## How It Works

The system runs your project through a phased lifecycle, each handled by specialized AI agents:

```
idea → ideation → specification → architecture → environment-setup
    → development → testing → review → deployment → A/B testing → monitoring
```

**Key features:**
- **Phase-based orchestration** — each phase produces artifacts consumed by the next
- **Dynamic agent factory** — creates domain-specific agents on the fly (e.g., a "quant researcher" for fintech projects)
- **Stack auto-discovery** — detects your tech stack and configures LSP servers, MCP servers, and Claude Code plugins automatically
- **Self-improvement engine** — benchmarks agent performance and evolves prompts via mutation + hill-climbing optimization
- **Git worktree sandbox** — evaluates mutations in isolated worktrees so your working directory stays clean
- **Checkpoint recovery** — state persisted to disk after each phase, resume any time

## Quickstart

### Prerequisites

- Node.js 20+
- [Claude Code](https://claude.ai/code) subscription (Pro, Max, or Team) — the system uses `@anthropic-ai/claude-agent-sdk` which runs through Claude Code's authentication, no separate API key needed

### Install

```bash
git clone https://github.com/aerbaser/autonomous-dev-system.git
cd autonomous-dev-system
npm install
npm run build
```

### Run via Claude Code (recommended)

The system is designed to run inside Claude Code. Open the project directory in Claude Code and ask it to start development:

```bash
# Open the project in Claude Code
cd autonomous-dev-system
claude

# Then in Claude Code, say:
# "Run autonomous-dev with idea: Build a real-time collaborative todo app"
```

Or run directly — Claude Code's SDK handles auth automatically when invoked within its context:

```bash
npx autonomous-dev run --idea "Build a real-time collaborative todo app with WebSocket sync"

# Check project status
npx autonomous-dev status

# Resume a previously started project (auto-detects state)
npx autonomous-dev run --idea "..." 

# Run a specific phase
npx autonomous-dev phase --name testing

# Run self-improvement optimization
npx autonomous-dev optimize --max-iterations 10
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

Environment variables (all optional):
- `GITHUB_TOKEN` — for GitHub integrations
- `SLACK_WEBHOOK_URL` — for Slack notifications
- `POSTHOG_API_KEY` — for analytics

> **Note:** No `ANTHROPIC_API_KEY` needed — the system uses Claude Agent SDK which authenticates through your Claude Code subscription.

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
├── hooks/                    # Claude Code hook handlers
│   ├── quality-gate.ts       # Lint check on TaskCompleted (async)
│   ├── security.ts           # Command/path deny-list enforcement
│   ├── idle-handler.ts       # Idle agent management
│   ├── audit-logger.ts       # Operation audit trail (JSONL)
│   ├── notifications.ts      # Slack/webhook alerts
│   └── improvement-tracker.ts # Tool usage metrics (TTL-evicted)
├── state/                    # Persistent state management
│   ├── project-state.ts      # Immutable state, ALL_PHASES, phase transitions
│   └── session-store.ts      # Session persistence
├── types/
│   └── llm-schemas.ts        # Zod schemas for all JSON parsing + structured output
└── utils/                    # Shared utilities
    ├── shared.ts             # extractFirstJson, isApiRetry, isRecord, errMsg
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

tests/                        # 182 tests across 28 files
```

## Commands

| Command | Description |
|---------|-------------|
| `autonomous-dev run --idea "..."` | Start autonomous development |
| `autonomous-dev status` | Show project state |
| `autonomous-dev phase --name <phase>` | Run specific phase |
| `autonomous-dev optimize` | Run self-improvement loop |

## Scripts

```bash
npm run build       # Compile TypeScript
npm run dev         # Run with tsx (no build)
npm run test        # Run all 182 tests
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

The system is ~85% → **100% feature-complete** per the original PLAN.md. All 15 implementation tasks are done. See `PRODUCT-REVIEW.md` and `VIBE-REVIEW.md` for expert analysis of next priorities.

## License

MIT
