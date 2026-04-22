# Roadmap: autonomous-dev-system

## Overview

This is **not** a from-zero build. The 12-phase lifecycle, dynamic Agent Factory, self-improvement loop, structured-output schemas, event bus, run ledger, task receipts, execution envelope, layered memory (L0/L2/L3/L4), codex-proxy, nightly runner, and static-HTML dashboard are all SHIPPED in code as of commit 19c663f (April 22, 2026), with 776/777 vitest passing and clean typecheck/lint.

The next milestone is **v1.0 Validation & Hardening**: prove the existing system works end-to-end on a real toy idea, close the critical security gaps from PRODUCT.md §16, fix the high-priority runtime bugs, and bring the static product gaps (PostHog, cloud deploy, `init`) up to "real" status. Six phases, executed in order, with end-to-end validation as the centerpiece (Phase 4).

Granularity: **standard** (6 phases). Each phase delivers a coherent, observable capability.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work.
- Decimal phases (2.1, 2.2): Reserved for urgent insertions discovered during execution.

- [x] **Phase 1: Test-Readiness Stabilization** — Restore 777/777 green baseline by fixing the non-interactive `--confirm-spec` timeout
- [ ] **Phase 2: Critical Security Backlog Closure** — Mitigate SDK CVE + 7 critical/security gaps from PRODUCT.md §16
- [ ] **Phase 3: High-Priority Runtime Fixes** — Wire rubric feedback loop, fix Interrupter race, replace specification stub, fix grader/optimizer/keyword-matching gaps
- [ ] **Phase 4: End-to-End Validation on a Toy Idea** — Run full 12-phase pipeline on a chosen toy idea; prove `--resume`, `--budget`, SIGINT-safe shutdown
- [ ] **Phase 5: Product-Gap Closure** — PostHog real for ab-testing, one cloud-deploy target wired, `autonomous-dev init` command
- [ ] **Phase 6: Self-Improvement Smoke Test** — Run `optimize` + `nightly` against the toy-idea agent team end-to-end

## Phase Details

### Phase 1: Test-Readiness Stabilization
**Goal**: Restore 777/777 green baseline so subsequent phases work against a clean test signal.
**Depends on**: Nothing (first phase)
**Requirements**: VAL-01
**Success Criteria** (what must be TRUE):
  1. `npm test` reports 777/777 passing (or current count, whichever is higher) — the previously-failing non-interactive `--confirm-spec` case in `tests/integration/orchestrator-autonomy.test.ts` (line 257) no longer times out
  2. `npm run typecheck` is clean
  3. `npm run lint` is clean
  4. The fix does not introduce a regression in any other test file (vitest run is fully green)
**Plans:** 1 plan

Plans:
- [x] 01-PLAN.md — Remove brittle 200ms `Promise.race` from non-interactive confirm-spec test; production code at `src/orchestrator.ts:590-598` is already correct (commit 4fc0ce5, 2026-04-22)

### Phase 2: Critical Security Backlog Closure
**Goal**: Close the eight critical/security items from PRODUCT.md §16 so the system can be run on real ideas without known critical exposure.
**Depends on**: Phase 1
**Requirements**: SEC-01, SEC-02, SEC-03, SEC-04, SEC-05, SEC-06, SEC-07, SEC-08
**Success Criteria** (what must be TRUE):
  1. `@anthropic-ai/claude-agent-sdk` is at a fixed version covering CVE GHSA-5474-4w2j-mq4c; CI passes
  2. Every interpolated variable in `src/self-improve/mutation-engine.ts` flows through `wrapUserInput(tag, content)` (DEC-014 holds project-wide)
  3. LSP install commands in `src/environment/lsp-manager.ts` reject unknown executables via an allowlist; existing tests still pass
  4. The mutation sandbox in `src/self-improve/sandbox.ts` rejects forbidden binaries; a denied invocation is observable in test output
  5. `src/hooks/security.ts` `PreToolUse` deny-list applies to `Glob`, `Grep`, `Agent`, and `WebFetch` (in addition to existing Bash/Read/Write/Edit coverage)
  6. `src/state/memory-store.ts` `topicPattern` regex is bounded so a malicious large input cannot trigger ReDoS within a measured ceiling
  7. Every write site under `.autonomous-dev/` is path-traversal-validated, not only via the existing `assertSafePath(stateDir)`
  8. `Config` object contains no `apiKey` field; Anthropic auth is sourced exclusively from `process.env` and is not logged
**Plans:** 8 plans

Plans:
- [x] 01-PLAN.md — SEC-01: pin `@anthropic-ai/claude-agent-sdk` to GHSA-5474-4w2j-mq4c-fixed version (wave 1) — completed 2026-04-22 (commit a13afda)
- [ ] 02-PLAN.md — SEC-02: wrap every interpolated variable in `mutation-engine.ts` prompts with `wrapUserInput` (wave 2)
- [ ] 03-PLAN.md — SEC-03: LSP install executable allowlist in `lsp-manager.ts` (wave 2)
- [ ] 04-PLAN.md — SEC-04: sandbox allowlist + FORBIDDEN_BINARIES denylist in `sandbox.ts` (wave 2)
- [ ] 05-PLAN.md — SEC-05: add Agent matcher branch to `security.ts` PreToolUse hook (wave 2)
- [ ] 06-PLAN.md — SEC-06: bound `topicPattern` input with MAX_TOPIC_PATTERN_LENGTH in `memory-store.ts` (wave 2)
- [ ] 07-PLAN.md — SEC-07: add `assertSafeWritePath` helper + wire to `.autonomous-dev/` write boundaries (wave 2)
- [ ] 08-PLAN.md — SEC-08: audit + lock Anthropic API key out of Config schema (wave 2)

### Phase 3: High-Priority Runtime Fixes
**Goal**: Resolve the six high-priority runtime defects so the orchestrator behaves predictably under retry, parallel runs, rubric feedback, and domain-specific task assignment.
**Depends on**: Phase 1 (clean baseline). Independent of Phase 2.
**Requirements**: HIGH-01, HIGH-02, HIGH-03, HIGH-04, HIGH-05, HIGH-06
**Success Criteria** (what must be TRUE):
  1. A phase that returns a `needs_revision` rubric verdict is automatically re-run with the verdict feedback inlined into the prompt (subject to retry budget); a `failed` verdict escalates to RunLedger with `verification_failed` (HIGH-01)
  2. The grader never replaces an LLM-emitted structured verdict — verdict precedence is asserted in tests (HIGH-02)
  3. Two parallel `run` invocations install independent `Interrupter` instances; SIGINT to one does not cross-fire to the other (HIGH-03)
  4. `src/phases/specification.ts` is a real handler (not a stub) and the previous circular import is gone; `npm run typecheck` confirms (HIGH-04)
  5. `src/self-improve/optimizer-runner.ts` rejects unverified blueprints — only blueprints that pass the verifier are written to `.autonomous-dev/agents/{name}.v{N}.md` (HIGH-05)
  6. The development runner picks domain-specialized agents over base agents when a task description contains domain keywords matching an agent's blueprint (HIGH-06)
**Plans**: TBD

### Phase 4: End-to-End Validation on a Toy Idea
**Goal**: Pick one toy idea (e.g., "a CLI todo app with tags and due dates") and prove the full 12-phase pipeline runs against it, including resume, budget, and graceful interrupt.
**Depends on**: Phase 1, Phase 2, Phase 3
**Requirements**: VAL-02, VAL-03, VAL-04, VAL-05
**Success Criteria** (what must be TRUE):
  1. `autonomous-dev run "<toy-idea>"` (non-quick) completes all 12 phases and writes a final `state.json` with non-empty `state.spec`, `state.architecture`, `state.tasks`, `state.deployment`, `state.phaseResults.testing`, `state.phaseResults.review`, `state.phaseResults.monitoring`; total `state.totalCostUsd` recorded
  2. SIGINT during a deliberately-interrupted second run triggers graceful shutdown — process exits cleanly and `.autonomous-dev/state.json` is written before exit
  3. `autonomous-dev run --resume <sessionId>` restarts from the SIGINT-interrupted checkpoint and continues to completion without re-running already-completed phases
  4. `autonomous-dev run "<toy-idea>" --budget 1.00` (or any value calibrated to mid-pipeline) emits an 80% warning, completes the in-flight phase, and stops at 100% without starting a new phase; `state.totalCostUsd` is at or below the cap
  5. All artifacts of the validation run (final `state.json`, `events/{runId}.jsonl`, `events/{runId}.summary.json`, all `receipts/{runId}/*.json`) exist and parse cleanly via their Zod schemas
**Plans**: TBD

### Phase 5: Product-Gap Closure
**Goal**: Convert the three "conceptual / partial" items from PRODUCT.md §16 (PostHog, cloud deploy, `init`) into shipped, real implementations so v1.0 is operationally complete.
**Depends on**: Phase 4 (validation has confirmed the orchestrator works; now extend its surface)
**Requirements**: GAP-01, GAP-02, GAP-03
**Success Criteria** (what must be TRUE):
  1. With `POSTHOG_API_KEY` set, the `ab-testing` phase creates a real PostHog feature flag and emits at least one experiment event; without the key it gracefully skips (existing OPTIONAL behavior preserved)
  2. The `staging` and `production` phases deploy to one real cloud provider (e.g., Vercel, Fly, or Render) via the shared `runDeployment` function — a successful deploy produces a reachable URL recorded in `state.deployment`
  3. `autonomous-dev init` exists as a CLI subcommand: it interactively bootstraps `.autonomous-dev/config.json`, runs an optional Codex preflight, and offers a sample idea string the operator can edit
  4. None of these additions break the toy-idea validation from Phase 4 — the same run succeeds again with the new code paths in scope
**Plans**: TBD

### Phase 6: Self-Improvement Smoke Test
**Goal**: Run the self-improvement loop and the nightly runner against the validated agent team and prove they produce a versioned blueprint, an evolution entry, and an updated dashboard.
**Depends on**: Phase 4 (need a real run with a real agent team to mutate against)
**Requirements**: VAL-06, VAL-07
**Success Criteria** (what must be TRUE):
  1. `autonomous-dev optimize --max-iterations 3` against the Phase-4 agent team completes without error; either at least one mutation is accepted (producing `.autonomous-dev/agents/{name}.v{N}.md` plus a `state.evolution[]` entry with `oldScore`, `newScore`, `diff`) OR all mutations are cleanly rejected with no working-directory contamination (worktrees cleaned up in `finally`)
  2. `autonomous-dev nightly` runs unattended (Codex preflight skipped via `NIGHTLY_ENV_FLAG`), generates an updated `.autonomous-dev/dashboard.html` reflecting the toy-idea run + any evolution entries, and survives at least one transient error without exiting
  3. Convergence detection respects `windowSize`, `minImprovement`, `maxStagnant` — the optimizer halts cleanly when stagnation thresholds are reached
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6. Phase 2 and Phase 3 are independent of each other (both need Phase 1) and could be parallelized in execution if desired, but the linear ordering is the default.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Test-Readiness Stabilization | 1/1 | Complete | 2026-04-22 |
| 2. Critical Security Backlog Closure | 0/8 | In progress | - |
| 3. High-Priority Runtime Fixes | 0/TBD | Not started | - |
| 4. End-to-End Validation on a Toy Idea | 0/TBD | Not started | - |
| 5. Product-Gap Closure | 0/TBD | Not started | - |
| 6. Self-Improvement Smoke Test | 0/TBD | Not started | - |
