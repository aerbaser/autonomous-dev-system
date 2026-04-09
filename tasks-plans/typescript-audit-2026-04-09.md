# TypeScript Audit Report — autonomous-dev-system

**Date:** 2026-04-09
**Skills used:** typescript-best-practices, typescript-magician, mastering-typescript
**Files audited:** 61 TypeScript source files in `src/`
**Baseline:** tsconfig strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes — all enabled

---

## Summary

| Category | Critical | Recommended | Already Good |
|----------|----------|-------------|-------------|
| Type Safety | 8 | 8 | `as const satisfies`, Zod boundaries, discriminated unions |
| Architecture | 3 | 5 | Immutable state, typed EventBus, functional patterns |
| Runtime Safety | 3 | 2 | safeParse, type guards, exhaustive switches |

**Overall Grade: A-** (strong foundation, main gap = Zod/interface duality)

---

## Critical Issues (P0–P1)

### C1. Zod schemas use `z.string()` where TypeScript expects literal unions
**Files:** `src/types/llm-schemas.ts` lines 339, 356; also `OssToolArraySchema:122`
**Impact:** `currentPhase`, `completedPhases`, `PhaseCheckpoint.phase`, `OssTool.type` all deserialize as `string` from JSON, but interfaces declare `Phase` / `OssType`. The `as ProjectState` cast in `loadState` hides the mismatch.
**Fix:** Replace `z.string()` with `z.enum([...ALL_PHASES])` for phase fields and `z.enum(["agent","skill","hook","mcp-server","pattern"])` for OssTool.type.

### C2. Dual type definitions — interfaces vs Zod infers
**Files:** `src/state/project-state.ts` (interfaces) vs `src/types/llm-schemas.ts` (Zod schemas)
**Impact:** `AgentBlueprint`, `Task`, `Deployment`, `ABTest`, `ProjectState` etc. are defined twice. Every `parsed.data as X` cast is a symptom. Changes to one side don't propagate to the other.
**Fix:** Make interfaces derived: `export type ProjectState = z.infer<typeof ProjectStateSchema>`. Remove manual interfaces. This is the single biggest improvement opportunity.

### C3. `EventLogger.generateRunSummary` — unsafe casts on disk data
**File:** `src/events/event-logger.ts:63–97`
**Impact:** `event.data as { inputTokens: number; ... }` — 3 casts without validation on data read from `.jsonl` files.
**Fix:** Define Zod schemas for `AgentQueryEndData` and `OrchestratorPhaseEndData`, use `.safeParse()`.

### C4. EventBus internal type erasure
**File:** `src/events/event-bus.ts:132–134, 177, 180`
**Impact:** `Map<string, Set<EventHandler>>` loses generic type parameter. `handler as EventHandler` is a design-level cast.
**Fix:** Accept this as a known tradeoff (type-safe API, erased internals) or refactor storage to `Map<EventType, Set<EventHandler<unknown>>>` with typed wrapper methods.

### C5. Module-level mutable `_activeInterrupter` — race condition
**File:** `src/orchestrator.ts:49`
**Impact:** Parallel orchestrator runs (tests, `singlePhase`) share one interrupter. SIGINT handler captures the last one.
**Fix:** Return `AbortController` from `runOrchestrator` or use `WeakMap<Promise, Interrupter>`.

### C6. `sandbox.ts` timeout — promise leak + no forced abort
**File:** `src/self-improve/sandbox.ts:215–231`
**Impact:** `Promise.race` with abort-listener promise that never rejects. `taskFn` receives signal but can ignore it.
**Fix:** Use `AbortSignal.timeout(timeoutMs)` (Node 17+) and ensure cleanup.

### C7. `ConsumeQueryOptions.model` accepts any string
**File:** `src/utils/sdk-helpers.ts:39`
**Fix:** Use model literal union from config schema.

### C8. Redundant `as Phase` in grader
**File:** `src/evaluation/grader.ts:115`
**Impact:** `state.currentPhase` is already `Phase`. The cast is redundant and masks potential issues.
**Fix:** Remove `as Phase`.

---

## Recommended Improvements (P2)

### R1. Brand types for ID fields
**File:** `src/state/project-state.ts`
**What:** `id`, `taskId`, `sessionId`, `runId`, `benchmarkId` are all `string`. Nothing prevents passing one where another is expected.
**Fix:** `type TaskId = string & { readonly __brand: "TaskId" }` etc.

### R2. `PhaseHandler` signature — options object instead of positional params
**File:** `src/phases/types.ts:23–29`
**What:** 5 params (3 optional) — hard to extend without updating all implementations.
**Fix:** Merge `checkpoint`, `sessionId`, `context` into `PhaseExecutionContext` object.

### R3. `phaseResults` key type
**File:** `src/state/project-state.ts:258`
**Fix:** `Partial<Record<Phase, PhaseResultSummary>>` instead of `Record<string, ...>`.

### R4. `EvaluatedPhaseResult` — use intersection with `PhaseResult`
**File:** `src/evaluation/rubric.ts:34–43`
**Fix:** `type EvaluatedPhaseResult = Omit<PhaseResult, "rubricResult"> & { rubricResult: RubricResult; totalIterations: number }`.

### R5. Inline `McpServerConfig` duplicated in development-runner
**Files:** `src/phases/development-runner.ts:583, 705`
**Fix:** Import and use `McpServerConfig` from `project-state.ts`.

### R6. DRY violation — rubric loop in orchestrator duplicates evaluate-loop
**Files:** `src/orchestrator.ts:537–614` vs `src/evaluation/evaluate-loop.ts`
**Fix:** Orchestrator should delegate to `evaluateWithRubric()`.

### R7. `phaseLabel` accepts `string` instead of `Phase`
**File:** `src/utils/progress.ts:43`
**Fix:** Change parameter type to `Phase`.

### R8. `BenchmarkResult.costUsd` optional but always set
**File:** `src/self-improve/benchmark-types.ts:31`
**Fix:** Make `costUsd: number` required.

### R9. No `noPropertyAccessFromIndexSignature` in tsconfig
**Fix:** Add to `tsconfig.json` for consistency with `noUncheckedIndexedAccess`.

### R10. Template literal types for event names
**What:** `"agent.query.start"`, `"orchestrator.phase.end"` etc. could use `${Category}.${Action}` pattern.
**Priority:** Low — current approach works, this is polish.

---

## Improvement Plan

### Phase 1: Type Foundation (P0 — high impact, moderate effort)
**Goal:** Eliminate Zod/interface duality — the root cause of most `as` casts.

| Step | Files | Effort |
|------|-------|--------|
| 1.1 Add `z.enum()` for Phase, TaskStatus, OssType in llm-schemas.ts | llm-schemas.ts | S |
| 1.2 Derive interfaces from Zod: `export type X = z.infer<typeof XSchema>` | project-state.ts, llm-schemas.ts | L |
| 1.3 Remove manual interfaces that duplicate Zod schemas | project-state.ts | M |
| 1.4 Remove `as ProjectState`, `as RegistryData` casts that become unnecessary | project-state.ts, registry.ts | S |
| 1.5 Add type-level tests with `expectTypeOf` (vitest) | tests/types.test.ts | S |

**Expected result:** ~15 `as` casts eliminated, compile-time guarantees for deserialization.

### Phase 2: Runtime Safety (P1 — prevents silent failures)

| Step | Files | Effort |
|------|-------|--------|
| 2.1 Add Zod schemas for EventLogger data shapes | event-logger.ts, event-bus.ts | M |
| 2.2 Fix `_activeInterrupter` race — return controller from `runOrchestrator` | orchestrator.ts, index.ts | M |
| 2.3 Fix sandbox timeout with `AbortSignal.timeout()` | sandbox.ts | S |
| 2.4 Constrain `model` field to literal union | sdk-helpers.ts, config.ts | S |
| 2.5 Remove redundant `as Phase` in grader | grader.ts | S |

### Phase 3: API Ergonomics (P2 — cleaner interfaces)

| Step | Files | Effort |
|------|-------|--------|
| 3.1 Introduce `PhaseExecutionContext` — replace positional params | phases/types.ts + all phase handlers | L |
| 3.2 Brand types for IDs (TaskId, SessionId, ProjectId) | project-state.ts + callers | M |
| 3.3 `Partial<Record<Phase, ...>>` for phaseResults | project-state.ts, llm-schemas.ts | S |
| 3.4 DRY: orchestrator delegates to evaluateWithRubric | orchestrator.ts | M |
| 3.5 Fix inline type duplication (McpServerConfig, AgentDefinitionLite) | development-runner.ts | S |

### Phase 4: Polish (P3 — nice to have)

| Step | Files | Effort |
|------|-------|--------|
| 4.1 Add `noPropertyAccessFromIndexSignature` to tsconfig | tsconfig.json + fixups | M |
| 4.2 Template literal types for event names | event-bus.ts | S |
| 4.3 Barrel exports for types (src/types/index.ts) | new file | S |
| 4.4 Update `lib` to ES2024 if Node 22+ | tsconfig.json | S |

---

## Effort Legend
- **S** = Small (< 30 min, < 3 files)
- **M** = Medium (1–2 hours, 3–8 files)
- **L** = Large (2–4 hours, 8+ files)

## Already Completed (this session)
- [x] All `any` usage — 0 found (clean)
- [x] All `enum` — 0 found (clean)
- [x] All `@ts-ignore` — 0 found (clean)
- [x] `as const satisfies` pattern — properly applied
- [x] `import type` — consistently used
- [x] Unsafe `as` assertions → type guards + null checks (commit 797b5e9)
- [x] JSON.parse without Zod → safeParse + isRecord (commit 797b5e9)
- [x] ALL_PHASES → `as const satisfies readonly Phase[]` (commit 797b5e9)
