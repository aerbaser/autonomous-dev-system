# Autonomy Test Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strengthen the repo's test strategy around unattended autonomy, CLI contracts, and currently uncovered infrastructure modules without regressing long-running autonomous execution.

**Architecture:** Add focused regression suites around the CLI, orchestrator autonomy behavior, plugin installation, and dashboard generation. Where current code can block unattended runs, add minimal hardening that preserves explicit opt-in behavior while preventing indefinite hangs in non-interactive environments.

**Tech Stack:** TypeScript, Vitest, Commander, Node fs/child_process mocks

---

### Task 1: CLI Contract Coverage

**Files:**
- Create: `tests/cli/index.test.ts`
- Modify: `src/index.ts`

- [ ] Add failing tests for `run`, `status`, `phase`, and error-path contracts.
- [ ] Add failing tests that prove existing state handling and invalid phase handling produce deterministic exit behavior.
- [ ] Implement the minimal `src/index.ts` changes needed to make CLI behavior testable without changing default autonomy semantics.
- [ ] Run targeted CLI tests.

### Task 2: Orchestrator Autonomy and Resume Guards

**Files:**
- Create: `tests/integration/orchestrator-autonomy.test.ts`
- Modify: `src/orchestrator.ts`

- [ ] Add failing tests for budget stop, checkpoint/session resume behavior, and `confirmSpec` behavior in interactive vs non-interactive execution.
- [ ] Add a failing regression test proving non-interactive `confirmSpec` does not block unattended runs indefinitely.
- [ ] Implement the minimal orchestrator hardening to preserve autonomy while keeping explicit `confirmSpec` opt-in behavior.
- [ ] Run targeted orchestrator integration tests.

### Task 3: Environment and Dashboard Gap Coverage

**Files:**
- Create: `tests/environment/plugin-manager.test.ts`
- Create: `tests/dashboard/generate.test.ts`
- Modify: `src/environment/plugin-manager.ts`
- Modify: `src/dashboard/generate.ts`
- Modify: `src/dashboard/template.ts`

- [ ] Add failing tests for successful plugin install, validation rejection, and command failure handling.
- [ ] Add failing tests for dashboard data collection with missing state, malformed events, sorted event ordering, and browser-open fallback behavior.
- [ ] Implement only the source changes needed to make these behaviors deterministic and testable.
- [ ] Run targeted environment/dashboard tests.

### Task 4: Full Verification

**Files:**
- Verify only

- [ ] Run `npm test`.
- [ ] Run `npm run build`.
- [ ] Review resulting diff for autonomy regressions or accidental interactive prompts.
