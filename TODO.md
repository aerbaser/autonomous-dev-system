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

## Completed in production-readiness pass (Apr 8, 2026)

- [x] Input sanitization: XML delimiters (`wrapUserInput`) for all user-derived content in prompts
- [x] Cost tracking: all phase handlers now capture and return `costUsd` from `consumeQuery()`
- [x] Zod-validated JSON.parse in ideation.ts, architecture.ts, development-runner.ts (was unsafe casts)
- [x] ProjectStateSchema: all 7 `z.unknown()` fields replaced with typed Zod schemas with `.catch()` for backward compat
- [x] ESLint: `ban-ts-comment` upgraded to error, `consistent-type-imports` added, CI `continue-on-error` removed

## Remaining

### Medium priority

#### ExternalBenchmarkFileSchema unused
`ExternalBenchmarkFileSchema` in llm-schemas.ts was used by the removed `loadBenchmarkTasks`. Either delete the schema or re-implement external benchmark loading.

#### Type-aware ESLint rules
`no-floating-promises` requires `projectService: true` which causes ESLint to take 15+ seconds. Enable when tooling performance improves.

### Low priority

#### Additional test coverage
- `tests/self-improve/mutation-engine.test.ts` — test each mutation type
- `tests/self-improve/versioning.test.ts` — test savePromptVersion
- `tests/hooks/notifications.test.ts` — test webhook delivery

#### Stream LLM output
`streamToConsole` was removed as dead code. If real-time output is wanted, re-implement by piping `assistant` messages to stdout during `consumeQuery`.
