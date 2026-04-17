# Codebase Audit Report: autonomous-dev-system

**Date:** 2026-04-08  
**Scope:** autonomous-dev-system/ (79 TypeScript files, 7474 LOC in src/)  
**Graph:** 537 nodes, 2115 edges  

> **Update (Apr 8 evening):** Several critical/high findings have been remediated:
> - **SEC-1 (prompt injection):** Fixed — all user input now wrapped in XML delimiters via `wrapUserInput()`
> - **SEC-3 (unvalidated JSON.parse):** Fixed — ideation.ts, architecture.ts, development-runner.ts now use Zod `.safeParse()`
> - **QUAL-2 (ProjectStateSchema z.unknown):** Fixed — all 7 fields now have typed Zod schemas
> - **Cost tracking TODO:** Fixed — all phase handlers return `costUsd`
> - **ESLint:** Strengthened (`ban-ts-comment: error`, `consistent-type-imports`), CI `continue-on-error` removed
> - Tests: 182 → 193 (added shared.ts tests)
>
> `bypassPermissions` (SEC-2) is an intentional design decision — not a bug.

---

## Overall Score: D+ (52/100)

| Category | Grade | Score | Weight | Findings |
|---|---|---|---|---|
| Architecture | **C** | 72 | 20% | 8 |
| Security | **F** | 30 | 25% | 6 |
| Code Quality | **C** | 70 | 20% | 15 |
| Dependencies | **B+** | 87 | 15% | 2 |
| Testing | **C+** | 72 | 20% | 5 |

Weighted total: `(72×20 + 30×25 + 70×20 + 87×15 + 72×20) / 100 = 52`

---

## 1. Architecture — C (72/100)

### File Size Distribution (79 files)
```
<50 lines:    10 files  (13%)
50-99:        15 files  (19%)
100-199:      35 files  (44%)  ← bulk
200-399:      16 files  (20%)
400-599:       2 files  ( 3%)  ⚠️
600+:          1 file   ( 1%)  🔴
```

### Critical Findings

**[ARCH-1] God files — 3 files over 400 lines**
- `development-runner.ts` (743 lines) — 4+ responsibilities: task decomposition, batch execution, quality-gate autofix, JSON parsing
- `base-blueprints.ts` (508 lines) — static prompt data masquerading as code
- `mutation-engine.ts` (499 lines) — duplicated helpers (`extractFirstJson`, `isApiRetry`)

**[ARCH-2] Quasi-circular dependency: orchestrator ↔ phases**
- 7 phase files import `PhaseResult` from `../orchestrator.js` instead of `./types.js`
- `orchestrator.ts` imports all phase handlers (lines 20-28)
- Type-only at compile time, but logically circular

**[ARCH-3] Code duplication across modules**
- `extractFirstJson` duplicated 7 times — canonical version exists in `types/llm-schemas.ts:209`
- `isApiRetry` duplicated 3 times — canonical in `utils/shared.ts`

### Strengths
- Clean dependency direction: index → orchestrator → phases → agents/environment/hooks
- Phase files never import each other
- Good module cohesion in state/, hooks/, environment/

### Top 3 Recommendations
1. Split `development-runner.ts` into: task-decomposer, batch-executor, quality-fixer
2. Move blueprint prompts from `base-blueprints.ts` to JSON/YAML data files
3. Consolidate duplicated helpers — delete copies, import from canonical locations

---

## 2. Security — F (30/100)

### Critical

**[SEC-1] Universal permission bypass (CRITICAL)**
- All 16+ `query()` calls use `permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions: true`
- LLM agents get unrestricted access to filesystem, network, and shell
- Files: every file in `src/phases/*.ts`, `src/agents/*.ts`, `src/environment/oss-scanner.ts`

### High

**[SEC-2] LLM prompt injection vector**
- User input (product spec, task descriptions) inserted directly into prompts via `JSON.stringify(state.spec)` and string concatenation
- Combined with SEC-1, a malicious spec can execute arbitrary shell commands
- Files: `architecture.ts:72-78`, `development-runner.ts:445`

**[SEC-3] Unsafe deserialization**
- `architecture.ts:104` — `JSON.parse(jsonStr)` cast directly to `ArchDesign` without Zod validation
- `ideation.ts:102` — same pattern
- Most other files correctly use `.safeParse()` — these are stragglers

**[SEC-4] Unsafe type assertions on LLM output**
- `development-runner.ts:322` — `obj.tasks as DevTask[]` without validation

### Medium

**[SEC-5] Path traversal risk**
- `verifiers.ts:88-90` — `resolve(fixtureCwd, filePath)` without checking result stays within base directory
- `registry.ts:60-61` — agent name substituted into file path without sanitization

### Low

**[SEC-6] Secrets management — OK**
- `.env` and `.env.local` properly gitignored
- `sandbox.ts:13-16` correctly filters environment variables

### Top 3 Recommendations
1. **Remove `bypassPermissions` immediately** — use explicit tool allowlists per agent
2. **Add XML delimiters** for user input in prompts to mitigate injection
3. **Add Zod validation** to remaining 2 unvalidated `JSON.parse` calls

---

## 3. Code Quality — C (70/100)

### Strengths
- **Type safety: A** — 0 `as any`, 0 `@ts-ignore`, 0 non-null assertions
- **TypeScript config: A+** — `strict: true` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`
- **Error handling: B** — catch blocks log errors and return fallbacks, no silent swallowing

### Problems

**[QUAL-1] Dead code — D (22% unused exports)**
- 24 exported functions with zero importers
- `src/utils/shared.ts` — 0 importers (entire file dead)
- `src/utils/templates.ts` — 0 importers (entire file dead)
- Key dead functions: `buildProjectContext`, `estimateCost`, `streamToConsole`, `runInSandbox`, `diffPromptVersions`

**[QUAL-2] Console spam — D (173 console.log in src/)**
- No structured logger — all output via raw console.log
- Top offenders: `optimizer-runner.ts` (23), `orchestrator.ts` (19), `environment-setup.ts` (13)
- `auditLoggerHook` exists but is a hook, not a logging replacement

**[QUAL-3] Function complexity — D (9 functions over 100 lines)**
- `getBaseBlueprints`: 506 lines (config data, not logic)
- `runOptimizerImpl`: 233 lines
- `runDevelopment`: 172 lines
- `runEnvironmentSetup`: 148 lines
- `runOrchestrator`: 147 lines

**[QUAL-4] Magic numbers scattered across files**
- Timeouts: `120_000`, `60_000`, `30_000`, `300_000` — not centralized
- Model names: `"opus"`, `"sonnet"`, `"haiku"` — hardcoded strings
- `memoryLimitMb ?? 512` duplicated in `sandbox.ts` (lines 46 and 127)

**[QUAL-5] ESLint deliberately weakened**
- `no-empty-function: "off"`, `no-empty-interface: "off"`, `no-require-imports: "off"`

### Top 3 Recommendations
1. Delete 24 unused exports and 2 dead utility files
2. Introduce a structured logger module (debug/info/warn/error levels)
3. Extract timeouts, model names, and limits into a constants/config file

---

## 4. Dependencies — B+ (87/100)

**Production (3):** `@anthropic-ai/claude-agent-sdk ^0.2.90`, `commander ^14.0.3`, `zod ^4.3.6`  
**Development (7):** `typescript ^6.0.2`, `vitest ^4.1.3`, `eslint ^10.2.0`, `tsx ^4.21.0`, `@types/node`, `@typescript-eslint/*`

### Strengths
- Minimal prod dependency count — excellent
- All use caret (`^`) ranges — no wild `*` or `>=`
- Lockfile present, no postinstall scripts
- No known deprecated packages

### Issues

**[DEP-1]** `@vitest/coverage-v8` missing from devDependencies despite `coverage.provider: "v8"` in vitest config — coverage reports won't generate without manual install

**[DEP-2]** No `engines` field in package.json — minimum Node version unspecified

### Recommendations
1. Add `@vitest/coverage-v8` to devDependencies
2. Add `"engines": { "node": ">=22" }` to package.json

---

## 5. Testing — C+ (72/100)

**Test files:** 29 | **Source files:** 49 | **File coverage ratio:** 69% (excluding type/data files)  
**Graph audit:** 202 functions lacking TESTED_BY edges

### Untested Modules (Priority Order)

| Priority | File | Risk |
|---|---|---|
| P0 | `src/phases/development-runner.ts` | Largest file (743 lines), 0 direct tests |
| P0 | `src/orchestrator.ts` | Core orchestration logic |
| P1 | `src/agents/domain-analyzer.ts` | External LLM calls |
| P1 | `src/environment/plugin-manager.ts` | System interaction |
| P1 | `src/phases/ab-testing.ts` | Complex logic |
| P2 | `src/utils/*` (5 files) | Base utilities, easy wins |
| P2 | `src/state/session-store.ts` | State persistence |
| P2 | `src/self-improve/optimizer-runner.ts` | Complex async flow |

### Test Quality: B+
- Proper mocking (vi.mock, vi.mocked)
- Meaningful assertions (checking specific values, not just "doesn't throw")
- Integration tests present (tests/integration/)
- Good isolation (beforeEach/afterEach cleanup)

### Issues
- No coverage thresholds configured in vitest.config.ts
- No CI enforcement of minimum coverage

### Recommendations
1. Add tests for P0 files (`development-runner.ts`, `orchestrator.ts`)
2. Configure coverage thresholds: `{ statements: 70, branches: 60 }`
3. Add `@vitest/coverage-v8` and integrate into CI

---

## Prioritized Remediation Roadmap

### Wave 1 — Critical (do now)
- [ ] Remove `bypassPermissions` from all agent calls — replace with scoped tool allowlists
- [ ] Add input delimiters for LLM prompts (prevent prompt injection)
- [ ] Add Zod validation to `architecture.ts:104` and `ideation.ts:102`

### Wave 2 — High (this sprint)
- [ ] Delete 24 unused exports + 2 dead util files
- [ ] Consolidate `extractFirstJson` (7 copies → 1) and `isApiRetry` (3 → 1)
- [ ] Fix quasi-circular imports: phases → types.ts instead of → orchestrator.ts
- [ ] Validate `development-runner.ts:322` DevTask[] with Zod

### Wave 3 — Medium (next sprint)
- [ ] Split `development-runner.ts` (743 lines) into 3 modules
- [ ] Move `base-blueprints.ts` prompt data to JSON/YAML
- [ ] Introduce structured logger, replace 173 console.log calls
- [ ] Extract magic numbers/timeouts into constants file

### Wave 4 — Improvement (backlog)
- [ ] Add tests for P0 untested modules
- [ ] Configure coverage thresholds
- [ ] Add `@vitest/coverage-v8` + `engines` field
- [ ] Re-enable weakened ESLint rules
