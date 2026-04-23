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
- Wired in: `architecture`, `review`, `testing` phases
- Each phase spawns a multi-specialist team via the Agent tool:
  - architecture: security-reviewer + scalability-reviewer
  - review: security-auditor + accessibility-auditor
  - testing: edge-case-finder + property-tester
- Primitive: `src/orchestrator/lead-driven-phase.ts` → `runLeadDrivenPhase`
- Contracts: `src/orchestrator/phase-contracts/*.contract.ts`
- Specialists: `src/agents/phase-specialist-blueprints.ts`
- Backloop guard: `state.backloopCounts[${from}->${to}]`, capped per contract
- History: `state.phaseAttempts[phase][]` (append-only; `phaseResults` kept as "latest")
- Safety: specialists NEVER get the Agent tool (defensive strip in primitive)

## Testing
- Run `npm test` (vitest) — 875 tests
- Run `npm run typecheck` for type checking
