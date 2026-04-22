# Constraints

Hard rules and contracts the project must obey, extracted from `PRODUCT.md` §15 (Invariants and conventions) plus distributed contract sections.

Source of truth: `/Users/admin/Desktop/AI/Web2/autonomous-dev-system/PRODUCT.md` (commit c4b504d, April 17, 2026).

---

## Runtime constraints

### CON-runtime-esm

- **Type:** protocol
- **Source:** `PRODUCT.md` §15 (Runtime)
- **Constraint:** ESM modules required. `package.json` declares `"type": "module"`. All internal import paths use `.js` extensions; TypeScript resolves them at build time.

### CON-runtime-async-only

- **Type:** protocol
- **Source:** `PRODUCT.md` §15 (Runtime)
- **Constraint:** Async I/O only. `execFile` (promisified) is mandatory; `execFileSync` is forbidden. Exception: `fs.*Sync` permitted for small state files when wrapped in `withStateLock`.

### CON-runtime-sdk-wrapper

- **Type:** api-contract
- **Source:** `PRODUCT.md` §15 (Runtime)
- **Constraint:** All `query()` calls from `@anthropic-ai/claude-agent-sdk` must use the `consumeQuery()` wrapper in `src/utils/sdk-helpers.ts`. Direct calls bypass cost/token tracking.

### CON-runtime-hook-callback-type

- **Type:** api-contract
- **Source:** `PRODUCT.md` §15 (Runtime)
- **Constraint:** All hooks must use the `HookCallback` type from the SDK.

### CON-runtime-permission-mode

- **Type:** protocol
- **Source:** `PRODUCT.md` §15 (Runtime)
- **Constraint:** SDK permission mode for autonomous runs is `acceptEdits`. `bypassPermissions` is forbidden (blocked under root historically).

### CON-runtime-typescript-strict

- **Type:** nfr
- **Source:** `PRODUCT.md` §16 (Implementation status — "clean typecheck + lint")
- **Constraint:** TypeScript strict mode is enforced and CI must pass `npm run typecheck` and `npm run lint` cleanly. No suppressions without explicit comment.

### CON-runtime-node20

- **Type:** nfr
- **Source:** `README.md` Prerequisites + `PRODUCT.md` §15 ESM context
- **Constraint:** Node.js 20+ required (also compatible with Node 16+ ESM module resolution).

---

## Data and validation constraints

### CON-data-immutable-state

- **Type:** protocol
- **Source:** `PRODUCT.md` §15 (Data and validation)
- **Constraint:** State is immutable. `addTask`, `updateTask`, `saveCheckpoint` always return new state objects. No in-place mutation anywhere.

### CON-data-zod-safeparse

- **Type:** schema
- **Source:** `PRODUCT.md` §15 (Data and validation)
- **Constraint:** All `JSON.parse` results must be validated through Zod `.safeParse()`. `as T` casts on parsed JSON are forbidden. Canonical schemas live in `src/types/llm-schemas.ts`.

### CON-data-extract-first-json

- **Type:** api-contract
- **Source:** `PRODUCT.md` §15 (Data and validation)
- **Constraint:** JSON extraction from LLM text must use `extractFirstJson` from `src/utils/shared.ts`. No re-implementation.

### CON-data-error-message

- **Type:** api-contract
- **Source:** `PRODUCT.md` §15 (Data and validation)
- **Constraint:** Error messages assembled via `errMsg(err)` from `src/utils/shared.ts`. No ad-hoc `String(err)` or `err.message`.

### CON-data-wrap-user-input

- **Type:** schema
- **Source:** `PRODUCT.md` §15 (Data and validation)
- **Constraint:** All user-derived content wrapped with `wrapUserInput(tag, content)` before insertion into prompts. XML delimiters required. Applies project-wide; gap in `mutation-engine.ts` is tracked but the rule still holds.

### CON-data-structured-output

- **Type:** schema
- **Source:** `PRODUCT.md` §15 (Data and validation)
- **Constraint:** Structured output uses Zod schemas + SDK `outputFormat`. Required in `testing`, `review`, `deployment`, `monitoring`, `development.decomposeTasks`. Text fallback via `extractFirstJson` permitted.

### CON-data-project-state-schema

- **Type:** schema
- **Source:** `.claude/CLAUDE.md` Conventions + `PRODUCT.md` §15
- **Constraint:** `ProjectStateSchema` in `src/types/llm-schemas.ts` is fully typed; no `z.unknown()` placeholders permitted.

---

## Cost and observability constraints

### CON-cost-phase-result-required

- **Type:** api-contract
- **Source:** `PRODUCT.md` §15 (Costs)
- **Constraint:** Every phase handler must return `costUsd` as part of `PhaseResult`. The orchestrator accumulates this into `state.totalCostUsd`. Missing `costUsd` is a contract violation.

### CON-cost-tracking-source

- **Type:** api-contract
- **Source:** `PRODUCT.md` §1 + §13
- **Constraint:** Cost is tracked from `consumeQuery().cost` only. No alternative cost computation paths.

### CON-event-shape

- **Type:** schema
- **Source:** `PRODUCT.md` §7 (EventLogger)
- **Constraint:** Each event in `.autonomous-dev/events/{runId}.jsonl` must have shape `{type, timestamp, seq, data}` where `data` matches the typed interface for the event type.

---

## Security constraints

### CON-sec-path-traversal

- **Type:** nfr
- **Source:** `PRODUCT.md` §15 (Security)
- **Constraint:** `assertSafePath(stateDir)` enforced in `src/state/project-state.ts`. Absolute paths allowed; relative paths must not escape `cwd`.

### CON-sec-mcp-args

- **Type:** nfr
- **Source:** `PRODUCT.md` §15 (Security)
- **Constraint:** MCP config args validated element-by-element against suspicious patterns: `--eval`, `-e`, `-c`, `--require`. Reject if matched.

### CON-sec-deny-list-hook

- **Type:** nfr
- **Source:** `PRODUCT.md` §10 (Hooks)
- **Constraint:** `hooks/security.ts` enforces deny-list (`rm -rf`, `sudo`, `curl | sh`, path-traversal, credential paths) on `PreToolUse` for Bash/Read/Write/Edit. Known gap: Glob/Grep/Agent/WebFetch not yet covered (backlog).

### CON-sec-secret-handling

- **Type:** nfr
- **Source:** `PRODUCT.md` §16 (Open work — "Remove API key from Config object")
- **Constraint:** Anthropic API key must live only in `process.env`, never on the `Config` object (in-flight cleanup). Anthropic auth handled automatically via Claude Code subscription; no `ANTHROPIC_API_KEY` required.

---

## Storage layout constraints

### CON-storage-state-dir

- **Type:** protocol
- **Source:** `PRODUCT.md` §14 + `.claude/CLAUDE.md`
- **Constraint:** All runtime state stored in `.autonomous-dev/`. Not committed to git. Substructure:
  - `state.json` — full run state
  - `sessions.json` — per-phase SDK session IDs
  - `agents/` — `AgentRegistry` + `{name}.v{N}.md` blueprints
  - `events/{runId}.jsonl` + `events/{runId}.summary.json`
  - `memory/` — L0/L2/L3/L4 + MemoryStore docs
  - `receipts/{runId}/` — task receipts
  - `pending-questions.jsonl` — ask-user journal
  - `dashboard.html` — generated dashboard

### CON-storage-blueprint-versioning

- **Type:** protocol
- **Source:** `PRODUCT.md` §5 (Versioning)
- **Constraint:** Accepted mutations write `.autonomous-dev/agents/{agentName}.v{N}.md` and append a `state.evolution[]` entry with diff, old score, new score.

### CON-storage-receipts-path

- **Type:** protocol
- **Source:** `PRODUCT.md` §10 (Task Receipts)
- **Constraint:** Each task receipt is persisted at `.autonomous-dev/receipts/{runId}/{taskId}.json`.

---

## Memory constraints

### CON-memory-no-l1

- **Type:** schema
- **Source:** `PRODUCT.md` §8
- **Constraint:** Layered memory consists of L0, L2, L3, L4 only. L1 is removed as dead code. No new L1 producers/consumers permitted.

### CON-memory-store-limits

- **Type:** nfr
- **Source:** `PRODUCT.md` §8 + §13
- **Constraint:** MemoryStore default limits: 500 documents, 100 KB per document. Eviction is FIFO by `updatedAt` (not true TTL — TTL is a backlog item).

### CON-memory-injection-budget

- **Type:** nfr
- **Source:** `PRODUCT.md` §8
- **Constraint:** `memoryStore.search(phase, { limit: 5 })` is the per-phase injection budget. Adjustments must preserve token economics.

---

## Configuration constraints

### CON-config-zod-validated

- **Type:** schema
- **Source:** `PRODUCT.md` §13 (Конфиг)
- **Constraint:** Configuration loaded from `.autonomous-dev/config.json` (or `--config <path>`) is validated against the Zod schema in `src/utils/config.ts`. Unknown keys must be rejected or ignored explicitly per schema.

### CON-config-rubric-default-off

- **Type:** nfr
- **Source:** `PRODUCT.md` §9
- **Constraint:** `config.rubric.enabled` defaults to `false` for cost reasons. Operators must opt in via config or `--enable-rubrics`.

### CON-config-interactive-default-off

- **Type:** nfr
- **Source:** `PRODUCT.md` §10 (Ask-user)
- **Constraint:** `config.interactive.allowAskUser` defaults to `false`. When false, mid-phase questions journal to `pending-questions.jsonl` and never block.

### CON-config-maxturns-defaults

- **Type:** nfr
- **Source:** `PRODUCT.md` §13
- **Constraint:** Default per-phase `maxTurns`: development 30, testing 30, review 20, deployment 20, ideation/architecture 10, monitoring 10, decomposition 3.

---

## Phase-handler contract constraints

### CON-phase-handler-return

- **Type:** api-contract
- **Source:** `.claude/CLAUDE.md` Conventions + `PRODUCT.md` §3
- **Constraint:** Phase handlers return `PhaseResult` from `./phases/types.ts` (NOT from orchestrator). Fields: `success`, `state`, `nextPhase?`, `costUsd`, `durationMs`, `rubricResult?`.

### CON-phase-transitions-valid

- **Type:** protocol
- **Source:** `PRODUCT.md` §3
- **Constraint:** Phase transitions must come from `VALID_TRANSITIONS[currentPhase]`. Returning a `nextPhase` outside this list causes `canTransition` to return false and silently halts the orchestrator (historical bug — see skill `autonomous-dev-phase-transition-bug`).

### CON-phase-shared-deployment

- **Type:** api-contract
- **Source:** `PRODUCT.md` §3 (rows 8 + 11)
- **Constraint:** Phases `staging` and `production` share a single `runDeployment` implementation. Differentiation via `state.environment`. Forking deployment logic per phase is forbidden.

### CON-phase-optional-list

- **Type:** schema
- **Source:** `PRODUCT.md` §3
- **Constraint:** `OPTIONAL_PHASES` defined exactly once in `src/types/phases.ts`. Value: `["environment-setup", "review", "ab-testing", "monitoring"]`. Duplicating the list elsewhere is forbidden.

---

## Failure-attribution constraints

### CON-failure-canonical-codes

- **Type:** schema
- **Source:** `PRODUCT.md` §7
- **Constraint:** `CanonicalFailureReasonCode` is the union of allowed reason codes for `RunLedger` and `SpendGovernor`. Set: `provider_limit | provider_rate_limit | invalid_structured_output | verification_failed | blocked_filesystem | unsupported_team_runtime | transient | timeout | unknown`.

### CON-failure-task-receipt-open

- **Type:** schema
- **Source:** `PRODUCT.md` §7
- **Constraint:** `TaskReceipt.failureReasonCode` is `z.union([CanonicalFailureReasonCode, z.string()])` (open-ended) so that LLM can return emergent reasons without breaking parsing.
