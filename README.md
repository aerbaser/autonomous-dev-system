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
- An Anthropic API key (`ANTHROPIC_API_KEY` env var)

### Install

```bash
git clone https://github.com/aerbaser/autonomous-dev-system.git
cd autonomous-dev-system
npm install
npm run build
```

### Run

```bash
# Start a new project from an idea
export ANTHROPIC_API_KEY=sk-ant-...
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

Environment variables:
- `ANTHROPIC_API_KEY` — required
- `GITHUB_TOKEN` — for GitHub integrations
- `SLACK_WEBHOOK_URL` — for Slack notifications
- `POSTHOG_API_KEY` — for analytics

## Architecture

```
src/
├── index.ts                  # CLI entry point (commander)
├── orchestrator.ts           # Main phase loop with retry + checkpoints
├── phases/                   # Phase handlers (one per lifecycle stage)
│   ├── ideation.ts           # Idea → structured spec
│   ├── architecture.ts       # Spec → tech stack + architecture design
│   ├── environment-setup.ts  # Auto-configure LSP, MCP, plugins
│   ├── development.ts        # Task decomposition → parallel dev agents
│   ├── testing.ts            # Run tests, lint, typecheck
│   ├── review.ts             # Code review with fix suggestions
│   ├── deployment.ts         # Deploy to staging/production
│   ├── ab-testing.ts         # A/B test variants
│   └── monitoring.ts         # Health checks + alerts
├── agents/                   # Agent management
│   ├── factory.ts            # Dynamic domain-specific agent creation
│   ├── registry.ts           # Blueprint storage + performance tracking
│   └── stack-researcher.ts   # Tech stack analysis
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
│   ├── lsp-manager.ts        # LSP server discovery + install
│   ├── mcp-manager.ts        # MCP server discovery + prioritization
│   └── plugin-manager.ts     # Plugin discovery + conflict detection
├── hooks/                    # Claude Code hook handlers
│   ├── quality-gate.ts       # Pre-commit quality checks
│   ├── security.ts           # Security scanning
│   ├── idle-handler.ts       # Idle agent management
│   ├── audit-logger.ts       # Operation audit trail
│   ├── notifications.ts      # Slack/webhook alerts
│   └── improvement-tracker.ts # Tool usage metrics
├── state/                    # Persistent state management
│   ├── project-state.ts      # Immutable state + phase transitions
│   └── session-store.ts      # Session persistence
└── utils/                    # Shared utilities
    ├── config.ts             # Zod-validated config loading
    ├── retry.ts              # Exponential backoff retry
    ├── sdk-helpers.ts        # Claude Agent SDK wrappers
    └── templates.ts          # Prompt templates

benchmarks/                   # External benchmark definitions
├── code-quality/tasks.json
├── test-generation/tasks.json
├── spec-completeness/tasks.json
├── architecture-quality/tasks.json
└── domain-specific/README.md

tests/                        # 210 tests across 29 files
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
npm run test        # Run all 210 tests
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
