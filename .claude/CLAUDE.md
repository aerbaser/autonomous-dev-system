# Autonomous Development System

Self-improving multi-agent development system built on Claude Agent SDK.

## Architecture
- TypeScript, Node.js, ESM modules
- Claude Agent SDK for agent orchestration
- Phase-based lifecycle: ideation → architecture → environment-setup → development → testing → review → deploy → A/B test → monitor
- Dynamic agent creation via Agent Factory (domain-specific agents generated on the fly)
- Self-improvement via AutoAgent-style hill-climbing optimization
- Stack Researcher auto-discovers and configures LSP, MCP, plugins

## Conventions
- All source code in `src/`
- State persisted in `.autonomous-dev/`
- Agent blueprints in `.autonomous-dev/agents/`
- Use `query()` from `@anthropic-ai/claude-agent-sdk` for all agent calls
- Hooks use `HookCallback` type from the SDK
- Phase handlers return `PhaseResult` with success/nextPhase/state

## Testing
- Run `npm test` (vitest)
- Run `npm run typecheck` for type checking
