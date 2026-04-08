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
- `src/utils/shared.ts` — shared helpers: `extractFirstJson`, `isApiRetry`, `isRecord`, `errMsg`
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

## Testing
- Run `npm test` (vitest) — 182 tests
- Run `npm run typecheck` for type checking
