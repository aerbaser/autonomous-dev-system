# Autonomous Dev System — Implementation TODO

Status: ~85% complete. 6,000 lines, 41 files, 76 tests.
This document maps every gap between PLAN.md and the current codebase.

**How to use:** Each task is self-contained with file paths, context, and acceptance criteria.
Spawn one agent per task (or per wave). Tasks within a wave have no file conflicts.

---

## Wave 1 — Critical Missing Functionality

### 1.1 Extract `src/self-improve/verifiers.ts`

**Why:** PLAN.md specifies a standalone verifiers module. Currently verification logic is embedded in `benchmarks.ts` (lines ~330-510). This couples benchmarking with verification and prevents reuse.

**What to do:**
1. Create `src/self-improve/verifiers.ts`
2. Extract from `benchmarks.ts`:
   - `runDeterministicTask()` — runs shell command, returns pass/fail based on exit code
   - `runLlmTask()` — two-phase: generate output via agent → LLM judge scores 0-1
   - Verifier type definitions and interfaces
3. Export two verifier factories:
   ```typescript
   export function createDeterministicVerifier(command: string): Verifier;
   export function createLlmVerifier(evaluationPrompt: string, options?: LlmVerifierOptions): Verifier;
   ```
4. Update `benchmarks.ts` to import from `verifiers.ts`
5. Add `tests/self-improve/verifiers.test.ts` with at least 6 tests

**Files touched:** `src/self-improve/verifiers.ts` (new), `src/self-improve/benchmarks.ts` (refactor), `tests/self-improve/verifiers.test.ts` (new)

**Acceptance:** `npm run typecheck && npm test` passes. Benchmark behavior unchanged.

---

### 1.2 Create `src/hooks/idle-handler.ts`

**Why:** PLAN.md Phase 5 specifies a TeammateIdle hook for reassigning or shutting down idle agents. Currently missing.

**What to do:**
1. Create `src/hooks/idle-handler.ts`
2. Implement `idleHandlerHook: HookCallback` that:
   - Listens for `TeammateIdle` event (from `input.hook_event_name`)
   - Checks how long the agent has been idle (from event payload)
   - If idle > threshold (configurable, default 5 min): suggest shutdown
   - If tasks remain in queue: suggest reassignment to next pending task
   - Returns `{ systemMessage }` with action recommendation
3. Follow the same pattern as `quality-gate.ts` (44 lines, `HookCallback` type)
4. Add `tests/hooks/idle-handler.test.ts` with at least 4 tests

**Reference:** `src/hooks/quality-gate.ts` for hook pattern. `src/state/project-state.ts` for Task type.

**Files touched:** `src/hooks/idle-handler.ts` (new), `tests/hooks/idle-handler.test.ts` (new)

**Acceptance:** `npm run typecheck && npm test` passes.

---

### 1.3 Add git worktree isolation to `src/self-improve/sandbox.ts`

**Why:** PLAN.md specifies sandbox uses git worktrees for isolation. Currently only subprocess fork — mutations can corrupt the working directory.

**Current state:** `sandbox.ts` (159 lines) has `runInSandbox()` (fork) and `runCommandInSandbox()` (execFile). Both use process-level isolation only.

**What to do:**
1. Add to `sandbox.ts`:
   ```typescript
   export async function runInWorktreeSandbox(
     taskFn: (worktreeDir: string) => Promise<SandboxResult>,
     options: WorktreeSandboxOptions
   ): Promise<SandboxResult>
   ```
2. Implementation:
   - `git worktree add <tmpdir> --detach` to create isolated copy
   - Run `taskFn(worktreeDir)` with timeout
   - Capture result
   - `git worktree remove <tmpdir>` in finally block (always clean up)
   - On error: ensure cleanup still happens
3. Add `WorktreeSandboxOptions` extending `SandboxOptions` with `repoDir: string`
4. Keep existing `runInSandbox()` and `runCommandInSandbox()` untouched
5. Update `optimizer.ts` to use `runInWorktreeSandbox()` when evaluating mutations
6. Add `tests/self-improve/sandbox.test.ts` with at least 4 tests (create worktree, cleanup, timeout, error)

**Files touched:** `src/self-improve/sandbox.ts` (extend), `src/self-improve/optimizer.ts` (update call), `tests/self-improve/sandbox.test.ts` (new)

**Acceptance:** `npm run typecheck && npm test` passes. Existing sandbox functions unchanged.

---

### 1.4 Create `benchmarks/` directory structure

**Why:** PLAN.md specifies a root-level `benchmarks/` directory with task definitions, not just inline fixtures in `benchmarks.ts`.

**What to do:**
1. Create directory structure:
   ```
   benchmarks/
   ├── README.md
   ├── code-quality/
   │   └── tasks.json
   ├── spec-completeness/
   │   └── tasks.json
   ├── test-generation/
   │   └── tasks.json
   ├── architecture-quality/
   │   └── tasks.json
   └── domain-specific/
       └── README.md
   ```
2. Extract existing inline fixtures from `benchmarks.ts` into `tasks.json` files:
   - `CODE_QUALITY_FIXTURE` → `benchmarks/code-quality/tasks.json`
   - `TEST_GENERATION_FIXTURE` → `benchmarks/test-generation/tasks.json`
   - Other benchmark task definitions
3. Add `loadBenchmarkTasks(benchmarkId: string)` to `benchmarks.ts` that reads from `benchmarks/` dir
4. Keep inline defaults as fallback if external files don't exist
5. Write `benchmarks/README.md` explaining structure and how to add custom benchmarks
6. `benchmarks/domain-specific/README.md` — explains how to add per-project benchmarks

**Files touched:** `benchmarks/` (new dir), `src/self-improve/benchmarks.ts` (add loader), `benchmarks/README.md` (new)

**Acceptance:** `npm run typecheck && npm test` passes. Benchmarks work with and without external files.

---

## Wave 2 — Environment Discovery + Self-Improve Tests

### 2.1 Add discovery to `src/environment/lsp-manager.ts`

**Why:** Currently only installs pre-discovered LSP servers. PLAN.md requires searching Piebald-AI marketplace and package registries.

**Current state:** 44 lines — `smokeTestLsp()` and `installLspServers()` only.

**What to do:**
1. Add `discoverLspServers(languages: string[])` function:
   - For each language, search known LSP server mappings:
     - TypeScript → vtsls, typescript-language-server
     - Python → pyright, pylsp, ruff-lsp
     - Rust → rust-analyzer
     - Go → gopls
     - CSS/HTML → css-language-server, html-language-server
   - Optionally use `query()` with WebSearch to find LSP servers for uncommon languages
   - Return `LspConfig[]` with `installCommand` populated
2. Add `checkExistingLsp(language: string): LspConfig | null` — checks if an LSP is already installed
3. Keep `installLspServers()` unchanged
4. Add `tests/environment/lsp-discovery.test.ts` with at least 4 tests

**Files touched:** `src/environment/lsp-manager.ts` (extend), `tests/environment/lsp-discovery.test.ts` (new)

---

### 2.2 Add discovery to `src/environment/mcp-manager.ts`

**Why:** Currently only merges pre-discovered servers into `.mcp.json`. No search/prioritization logic.

**Current state:** 64 lines — `configureMcpServers()` and `getMcpServerConfigs()` only.

**What to do:**
1. Add `discoverMcpServers(techStack: string[], domain: string)` function:
   - Map common stacks to known MCP servers:
     - PostgreSQL → `@modelcontextprotocol/server-postgres`
     - Redis → `redis-mcp`
     - Playwright → `@anthropic-ai/mcp-playwright`
     - GitHub → `@modelcontextprotocol/server-github`
     - Docker → `docker-mcp`
   - Use `query()` with WebSearch for domain-specific MCPs (if domain is non-standard)
   - Return `McpDiscovery[]` with prioritization (official Anthropic > well-maintained community > other)
2. Add `prioritizeMcpServers(servers: McpDiscovery[]): McpDiscovery[]` — sort by trust score
3. Keep `configureMcpServers()` and `getMcpServerConfigs()` unchanged
4. Add `tests/environment/mcp-discovery.test.ts` with at least 4 tests

**Files touched:** `src/environment/mcp-manager.ts` (extend), `tests/environment/mcp-discovery.test.ts` (new)

---

### 2.3 Add discovery to `src/environment/plugin-manager.ts`

**Why:** Currently only installs plugins by name. No marketplace search or conflict detection.

**Current state:** 32 lines — `installPlugins()` only.

**What to do:**
1. Add `discoverPlugins(techStack: string[], domain: string)` function:
   - Map stacks to known useful plugins
   - Use `query()` with WebSearch to discover relevant Claude Code plugins
   - Return `PluginDiscovery[]`
2. Add `checkPluginConflicts(existing: PluginDiscovery[], newPlugins: PluginDiscovery[]): ConflictReport`:
   - Check if hooks might overlap
   - Check if skills duplicate existing agent capabilities
   - Return warnings (not blocking)
3. Keep `installPlugins()` unchanged
4. Add `tests/environment/plugin-discovery.test.ts` with at least 3 tests

**Files touched:** `src/environment/plugin-manager.ts` (extend), `tests/environment/plugin-discovery.test.ts` (new)

---

### 2.4 Self-improve test suite — `tests/self-improve/`

**Why:** Zero tests for the entire self-improvement engine (1,691 lines, 6 files). This is the most complex subsystem.

**What to do:**
1. Create `tests/self-improve/optimizer.test.ts`:
   - Test `selectTargetAgent()` picks worst-performing agent
   - Test optimization loop accepts improving mutations
   - Test optimization loop rejects worse mutations
   - Test convergence stops the loop
   - At least 5 tests

2. Create `tests/self-improve/mutation-engine.test.ts`:
   - Test each mutation type generates valid output
   - Test `selectMutationType()` distribution
   - Test apply/rollback on mutations
   - At least 4 tests

3. Create `tests/self-improve/convergence.test.ts`:
   - Test stagnation detection
   - Test plateau detection
   - Test minIterations floor
   - Test convergence report generation
   - At least 4 tests

4. Create `tests/self-improve/benchmarks.test.ts`:
   - Test `getDefaultBenchmarks()` returns 5 benchmarks
   - Test weight sum ≈ 1.0
   - Test `runDeterministicTask()` with passing/failing commands
   - At least 3 tests

**Files touched:** `tests/self-improve/` (4 new test files)

**Acceptance:** All new tests pass. No changes to source files.

---

## Wave 3 — Code Quality + Remaining Tests + Infra

### 3.1 Decompose `src/phases/development.ts` (680 lines)

**Why:** tasks.md critical item. Largest file in the project.

**What to do:**
1. Extract types to `src/phases/development-types.ts`:
   - `DevTask`, `TaskDecomposition`, `BatchResult`, `TaskResult`
2. Extract `runDevelopment` function body (lines ~45-218) into `src/phases/development-runner.ts`
3. `development.ts` becomes a thin orchestrator importing from the two new files
4. Update any imports across the project
5. Existing tests must still pass

**Files touched:** `src/phases/development.ts` (refactor), `src/phases/development-types.ts` (new), `src/phases/development-runner.ts` (new)

---

### 3.2 Decompose `src/self-improve/optimizer.ts` (251 lines)

**Why:** tasks.md high priority item.

**What to do:**
1. Extract `runOptimizer` function body (lines ~69-251) into `src/self-improve/optimizer-runner.ts`
2. `optimizer.ts` keeps exports and delegates to runner
3. Keep interfaces in optimizer.ts (they're part of the public API)

**Files touched:** `src/self-improve/optimizer.ts` (refactor), `src/self-improve/optimizer-runner.ts` (new)

---

### 3.3 Extract inline types from `src/self-improve/benchmarks.ts` (510 lines)

**Why:** tasks.md moderate priority item.

**What to do:**
1. Move `BenchmarkTask`, `BenchmarkFixture`, `Benchmark`, `BenchmarkResult` to `src/self-improve/benchmark-types.ts`
2. Re-export from `benchmarks.ts` for backwards compatibility
3. Update imports in files that use these types

**Files touched:** `src/self-improve/benchmarks.ts` (refactor), `src/self-improve/benchmark-types.ts` (new)

---

### 3.4 Phase handler tests

**Why:** Only ideation and orchestrator have integration tests. No unit tests for individual phase handlers.

**What to do:**
Create `tests/phases/` with tests for:
1. `architecture.test.ts` — test produces ArchDesign with techStack
2. `environment-setup.test.ts` — test calls LSP/MCP/plugin managers
3. `testing.test.ts` — test runs npm test/lint/typecheck
4. `review.test.ts` — test produces review output
5. `deployment.test.ts` — test handles staging vs production

At least 2 tests per file, 10 tests total.

**Files touched:** `tests/phases/` (5 new test files)

---

### 3.5 Remaining hook tests

**Why:** audit-logger, notifications, improvement-tracker have no tests.

**What to do:**
1. `tests/hooks/audit-logger.test.ts` — test logs file operations to JSONL, ignores non-PostToolUse
2. `tests/hooks/notifications.test.ts` — test sends to webhook, handles missing webhook URL
3. `tests/hooks/improvement-tracker.test.ts` — test tracks tool usage metrics

At least 2 tests per file, 6 tests total.

**Files touched:** `tests/hooks/` (3 new test files)

---

### 3.6 ESLint configuration

**Why:** `npm run lint` is called in quality-gate.ts but ESLint is not configured. The lint command will always fail or be skipped.

**What to do:**
1. Install: `npm install -D eslint @typescript-eslint/eslint-plugin @typescript-eslint/parser`
2. Create `eslint.config.js` (flat config format for ESLint 9+)
3. Add `"lint": "eslint src/"` to package.json scripts
4. Fix any lint errors that appear
5. Verify quality-gate hook works with real lint

**Files touched:** `eslint.config.js` (new), `package.json` (update scripts)

---

## Summary

| Wave | Tasks | New Files | Priority |
|------|-------|-----------|----------|
| **Wave 1** | 1.1-1.4 | 7 new files + 1 dir | Critical — missing functionality |
| **Wave 2** | 2.1-2.4 | 7 new files | High — discovery + test coverage |
| **Wave 3** | 3.1-3.6 | 13 new files | Medium — quality + polish |

**Total remaining:** ~27 new/modified files across 3 waves.

**File ownership (no conflicts within a wave):**
- Wave 1: verifiers.ts / idle-handler.ts / sandbox.ts / benchmarks/ — all independent
- Wave 2: lsp-manager.ts / mcp-manager.ts / plugin-manager.ts / tests/self-improve/ — all independent
- Wave 3: development.ts / optimizer.ts / benchmarks.ts / tests/ / eslint — all independent
