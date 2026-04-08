# Autonomous Dev System — TODO

Status: **~95% complete**. ~7,000 lines, 50 source files, 182 tests.

Last updated after 10-wave audit refactoring (Apr 8, 2026).

---

## Completed (from original TODO)

All Wave 1, 2, and 3 tasks are done except where noted:

- [x] 1.1 Extract `verifiers.ts` from benchmarks
- [x] 1.2 Create `idle-handler.ts` hook
- [x] 1.3 Git worktree isolation in `sandbox.ts` (runInWorktreeSandbox)
- [x] 1.4 `benchmarks/` directory with external task definitions
- [x] 2.1-2.3 Discovery functions were added, then **intentionally removed** (dead code — stack-researcher.ts handles discovery via LLM)
- [x] 2.4 Self-improve test suite (partial — optimizer-runner, convergence, benchmarks tested)
- [x] 3.1 Decompose `development.ts` → `development-runner.ts` + `development-types.ts`
- [x] 3.2 Decompose `optimizer.ts` → `optimizer-runner.ts`
- [x] 3.3 Extract benchmark types → `benchmark-types.ts` + `benchmark-defaults.ts`
- [x] 3.4 Phase handler tests (ideation, architecture, testing, env-setup, deployment)
- [x] 3.5 Hook tests (quality-gate, security, audit-logger, improvement-tracker)

## Completed in audit refactoring (Waves 1-10)

- [x] Consolidate `extractFirstJson` (6 buggy copies → 1 in shared.ts)
- [x] Consolidate `isApiRetry`, `isRecord` → shared.ts
- [x] Add `errMsg()` helper, replace 10+ inline patterns
- [x] Fix `raw as RegistryData` → `parseResult.data` in registry.ts
- [x] Add error logging to domain-analyzer/stack-researcher (was silent fallback)
- [x] Remove dead `sessionIds` field from ProjectState
- [x] Fix PhaseResult imports (from types.ts, not orchestrator)
- [x] Remove 7 TOCTOU `existsSync` before `mkdirSync({recursive:true})`
- [x] Add TTL eviction to toolStartTimes (memory leak fix)
- [x] Remove redundant `saveState` calls in orchestrator
- [x] Remove 16 dead exports (~1100 lines)
- [x] Consolidate `ALL_PHASES` → single source in project-state.ts
- [x] Consolidate `BASE_AGENT_NAMES` → derived from base-blueprints.ts
- [x] Reuse `state.spec.domain` in factory.ts (avoid duplicate API call)
- [x] Structured output for testing.ts and review.ts (TestingResultSchema, ReviewResultSchema)
- [x] Migrate `execFileSync` → async `execFile` (quality-gate, development-runner, lsp-manager, plugin-manager)
- [x] Simplify quality-gate hook to lint-only (tsc+test in runQualityChecks)
- [x] Parallelize environment-setup steps 2-5 via Promise.allSettled
- [x] Replace withTimeout dual-timer with AbortController
- [x] Harden ProjectStateSchema (spec → ProductSpecSchema, architecture → ArchDesignSchema)

---

## Remaining

### High priority

#### ESLint configuration
`npm run lint` is called in quality-gate hook but ESLint is not configured. Lint always fails silently.

**What to do:**
1. `npm install -D eslint @typescript-eslint/eslint-plugin @typescript-eslint/parser`
2. Create `eslint.config.js` (ESLint 9 flat config)
3. Fix lint errors
4. Verify quality-gate hook works with real lint

#### ProjectStateSchema — remaining z.unknown() fields
`environment`, `agents`, `tasks`, `deployments`, `abTests`, `evolution`, `checkpoints` still use `z.unknown()`. Need to create Zod schemas for: StackEnvironment, AgentBlueprint, Task, Deployment, ABTest, EvolutionEntry, PhaseCheckpoint.

### Medium priority

#### Cost tracking
Budget tracking in orchestrator has TODO comments — `query()` returns `total_cost_usd` via `consumeQuery()` but orchestrator doesn't aggregate it. Wire up `result.costUsd` from phase handlers.

#### ExternalBenchmarkFileSchema unused
`ExternalBenchmarkFileSchema` in llm-schemas.ts was used by the removed `loadBenchmarkTasks`. Either delete the schema or re-implement external benchmark loading.

### Low priority

#### Additional test coverage
- `tests/self-improve/mutation-engine.test.ts` — test each mutation type
- `tests/self-improve/versioning.test.ts` — test savePromptVersion
- `tests/hooks/notifications.test.ts` — test webhook delivery

#### Stream LLM output
`streamToConsole` was removed as dead code. If real-time output is wanted, re-implement by piping `assistant` messages to stdout during `consumeQuery`.
