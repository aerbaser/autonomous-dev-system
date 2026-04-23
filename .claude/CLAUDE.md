# Autonomous Development System

Self-improving multi-agent development system built on Claude Agent SDK.

## Architecture
- TypeScript, Node.js, ESM modules
- Claude Agent SDK for agent orchestration
- Phase-based lifecycle: ideation → specification → architecture → environment-setup → development → testing → review → staging → ab-testing → analysis → production → monitoring
- Dynamic agent creation via Agent Factory (domain-specific agents generated on the fly)
- Self-improvement via AutoAgent-style hill-climbing optimization
- Stack Researcher auto-discovers and configures LSP, MCP, plugins
- Graceful shutdown with SIGINT handler and checkpoint recovery

## Key modules
- `src/utils/shared.ts` — shared helpers: `extractFirstJson`, `isApiRetry`, `isRecord`, `errMsg`, `wrapUserInput`
- `src/utils/sdk-helpers.ts` — `consumeQuery`, `getQueryPermissions`, `getMaxTurns`
- `src/state/project-state.ts` — `ProjectState` type, `ALL_PHASES`, persistence, transitions
- `src/agents/base-blueprints.ts` — `getBaseBlueprints()`, `getBaseAgentNames()`
- `src/phases/types.ts` — `PhaseResult`, `PhaseHandler` types

## Conventions
- All source code in `src/`
- State persisted in `.autonomous-dev/`
- Agent blueprints in `.autonomous-dev/agents/`
- Use `query()` from `@anthropic-ai/claude-agent-sdk` for all agent calls
- Use `consumeQuery()` wrapper for consuming query streams
- Hooks use `HookCallback` type from the SDK
- Phase handlers return `PhaseResult` from `./phases/types.ts` (not from orchestrator)
- Async I/O: use `execFile` (promisified), not `execFileSync`
- JSON extraction: use `extractFirstJson` from `shared.ts` (handles strings with braces)
- Error messages: use `errMsg(err)` from `shared.ts`
- Structured output: phases use Zod schemas (e.g. `TestingResultSchema`) with text fallback
- Input sanitization: wrap user-derived content with `wrapUserInput(tag, content)` from `shared.ts`
- JSON.parse: always validate with Zod `.safeParse()`, never cast directly
- Cost tracking: all phase handlers must return `costUsd` from `consumeQuery().cost`
- ProjectStateSchema in `llm-schemas.ts` — fully typed, no `z.unknown()`

## v1.1 super-lead mode
- Opt-in via `AUTONOMOUS_DEV_LEAD_DRIVEN=1` env var
- Wired in: `specification`, `architecture`, `review`, `testing` phases (4 of 12)
- Each phase spawns a multi-specialist team via the Agent tool:
  - specification: nfr-analyst + out-of-scope-guard
  - architecture: security-reviewer + scalability-reviewer
  - review: security-auditor + accessibility-auditor
  - testing: edge-case-finder + property-tester
- Primitive: `src/orchestrator/lead-driven-phase.ts` → `runLeadDrivenPhase`
- Contract type: `src/orchestrator/phase-contract.ts` → `PhaseContract`
- Per-phase contracts: `src/orchestrator/phase-contracts/*.contract.ts`
- Specialists: `src/agents/phase-specialist-blueprints.ts` (8 handwritten blueprints, auto-registered by `AgentRegistry.load()` — backfills existing registries)
- Backloop guard: `state.backloopCounts["${from}->${to}"]`, capped per contract via `maxBackloopsFromHere`
- Global livelock guard: `GLOBAL_MAX_BACKLOOPS = 5` in `src/orchestrator.ts` — halts the run and writes `backloop_livelock_guard` to log
- History: `state.phaseAttempts[phase][]` (append-only, includes every backloop re-entry; `phaseResults` kept as "latest attempt" for back-compat)
- Safety: specialists NEVER get the Agent tool (defensive strip via `sanitizeSpecialistTools` in the primitive, regardless of blueprint)
- State migration: pre-v1.1 `state.json` loads transparently — `phaseAttempts`/`backloopCounts` default to `{}` via `.catch({})` in `ProjectStateSchema`

### Testing super-lead E2E
Run the lead-driven path on a toy idea (tiny budget to keep it cheap):
```bash
AUTONOMOUS_DEV_LEAD_DRIVEN=1 npm run dev -- run --idea "CLI todo app with tags" --quick --budget 2.00
```

### Where artifacts land
After a run, inspect under `config.stateDir` (default `.autonomous-dev/`):
- `state.json` — includes `phaseAttempts` (append-only history) and `backloopCounts` (per-pair counter) at the top level
- `ledger/{runId}.json` — `RunLedgerSnapshot` (per-session spend, topology, ledger events)
- `events/{runId}.jsonl` + `events/{runId}.summary.json` — EventBus timeline
- `receipts/{runId}/{taskId}.json` — per-task `TaskReceipt` from development phase
- `dashboard.html` — produced by `autonomous-dev dashboard` or `autonomous-dev nightly`; renders evolution entries + latest run summary

## Testing
- Run `npm test` (vitest) — 881 tests
- Run `npm run typecheck` for type checking
