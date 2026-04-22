---
phase: 01-test-readiness-stabilization
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - tests/integration/orchestrator-autonomy.test.ts
autonomous: true
requirements:
  - VAL-01
must_haves:
  truths:
    - "`npm test` exits 0 with every test in tests/integration/orchestrator-autonomy.test.ts passing, including the non-interactive confirm-spec case at line 257"
    - "`npm run typecheck` exits 0 with zero diagnostics"
    - "`npm run lint` exits 0"
    - "The non-interactive confirm-spec test no longer races against an artificial 200ms deadline — it relies on vitest's per-test timeout only"
    - "The interactive confirm-spec test at line 224 still passes unchanged (the fix does not regress sibling cases)"
    - "No source file under src/ is modified — the production code path in src/orchestrator.ts:590-598 is already correct"
  artifacts:
    - path: "tests/integration/orchestrator-autonomy.test.ts"
      provides: "Updated non-interactive confirm-spec test that awaits runOrchestrator directly"
      contains: "does not block unattended runs in non-interactive confirm-spec mode"
  key_links:
    - from: "tests/integration/orchestrator-autonomy.test.ts:257"
      to: "src/orchestrator.ts:590"
      via: "runWithTTY(false, ...) forces process.stdin.isTTY=false; orchestrator takes the non-interactive branch that skips process.stdin.once"
      pattern: "runWithTTY\\(false"
    - from: "tests/integration/orchestrator-autonomy.test.ts assertions"
      to: "onceSpy"
      via: "vi.spyOn(process.stdin, 'once') — assertion proves confirm-spec did not attempt to pause"
      pattern: "expect\\(onceSpy\\)\\.not\\.toHaveBeenCalled"
---

<objective>
Restore the 777/777 green test baseline (VAL-01) by removing a brittle 200ms `Promise.race` guard in the non-interactive confirm-spec test. The production code at `src/orchestrator.ts:582-598` already handles the `process.stdin.isTTY === false` path correctly by logging "Non-interactive stdin detected; continuing without pause." and skipping the `process.stdin.once("data", ...)` call. The test failure is purely test-side: the mocked 3-phase orchestrator flow (ideation → specification → architecture) takes longer than 200ms to finish on this machine, so the artificial timeout rejects before the flow completes — even though the branch under test never paused.

Purpose: unblock Phases 2–6 (all depend on a clean test signal) and close the one remaining caveat on REQ-confirm-spec-gate in `.planning/REQUIREMENTS.md` §Validated.

Output: an updated test file where the non-interactive case awaits `runOrchestrator(state, config)` directly, relying on vitest's default 5000ms per-test timeout to catch any future regression where `.once` is called without stdin input.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/ROADMAP.md
@.planning/REQUIREMENTS.md
@.planning/STATE.md
@.planning/intel/constraints.md
@.claude/CLAUDE.md
@.claude/skills/typescript/SKILL.md

<interfaces>
<!-- Production code that the test exercises (already correct — DO NOT MODIFY). -->
<!-- From src/orchestrator.ts:582-598: -->

```typescript
// Confirm-spec pause: wait for user confirmation after specification phase
if (phase === "specification" && confirmSpec) {
  if (state.spec) {
    console.log(`[confirm] Spec summary: ${state.spec.summary}`);
    console.log(
      `[confirm] User stories: ${state.spec.userStories.length}, ` +
      `NFRs: ${state.spec.nonFunctionalRequirements.length}`
    );
  }
  if (process.stdin.isTTY) {
    console.log(
      "[confirm] Spec generated. Review above and press Enter to continue, or Ctrl+C to abort."
    );
    await new Promise((resolve) => process.stdin.once("data", resolve));
  } else {
    console.log("[confirm] Non-interactive stdin detected; continuing without pause.");
  }
}
```

<!-- Test helper that forces the non-TTY code path — from tests/integration/orchestrator-autonomy.test.ts:130-149: -->

```typescript
async function runWithTTY(
  value: boolean,
  fn: () => Promise<void>,
): Promise<void> {
  const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
  const original = Object.getOwnPropertyDescriptor(stdin, "isTTY");
  Object.defineProperty(stdin, "isTTY", {
    value,
    configurable: true,
  });
  try {
    await fn();
  } finally {
    if (original) {
      Object.defineProperty(stdin, "isTTY", original);
    } else {
      delete (stdin as { isTTY?: boolean }).isTTY;
    }
  }
}
```

<!-- vitest.config.ts has no `testTimeout` override — default 5000ms per-test timeout applies. -->
<!-- That 5000ms is the hang-guard that replaces the hand-rolled 200ms Promise.race. -->
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Remove 200ms Promise.race from non-interactive confirm-spec test</name>
  <files>tests/integration/orchestrator-autonomy.test.ts</files>

  <read_first>
    - tests/integration/orchestrator-autonomy.test.ts (full file — especially lines 257-290 for the target test, and lines 224-255 for the interactive sibling which MUST continue to pass unchanged)
    - src/orchestrator.ts lines 580-600 (confirms the non-TTY branch is already correct; no production change needed)
    - vitest.config.ts (confirms no testTimeout override — default 5000ms applies as the replacement hang-guard)
  </read_first>

  <action>
    Edit `tests/integration/orchestrator-autonomy.test.ts`. Replace the body of the test starting at line 257 so the orchestrator call is awaited directly — no `Promise.race`, no artificial 200ms timeout.

    **Before (lines 276-286):**
    ```typescript
        const onceSpy = vi.spyOn(process.stdin, "once");
        const timeout = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("runOrchestrator timed out waiting for confirm-spec input")), 200);
        });

        await runWithTTY(false, async () => {
          await Promise.race([
            runOrchestrator(state, config),
            timeout,
          ]);
        });
    ```

    **After:**
    ```typescript
        const onceSpy = vi.spyOn(process.stdin, "once");

        await runWithTTY(false, async () => {
          await runOrchestrator(state, config);
        });
    ```

    Leave the surrounding test unchanged:
    - The test's name ("does not block unattended runs in non-interactive confirm-spec mode") stays as-is.
    - The three `mockedRun*.mockImplementationOnce(...)` / `.mockResolvedValueOnce(...)` setups above stay as-is.
    - The existing assertions stay as-is: `expect(onceSpy).not.toHaveBeenCalled();` and `expect(mockedRunArchitecture).toHaveBeenCalledTimes(1);`.

    Why this is safe (and why vitest's default per-test timeout is a sufficient hang-guard):
    - If `process.stdin.isTTY` were ever `true` inside `runWithTTY(false, ...)` (regression), the production code at `src/orchestrator.ts:594` would call `process.stdin.once("data", resolve)`. The spy at line 276 would observe that call and the assertion `expect(onceSpy).not.toHaveBeenCalled()` would fail after the orchestrator eventually resolved — or, if the pause were real, vitest's default 5000ms per-test timeout would fail the test with a clear timeout error. Either way, regressions remain detectable; the 200ms race was redundant with the spy assertion.
    - `runWithTTY` restores the original `isTTY` descriptor in a `finally` block, so no leakage into sibling tests.

    Do NOT:
    - Do NOT modify `src/orchestrator.ts` — the production code is correct.
    - Do NOT change the other three tests in the file (budget-cap at line 162, resume at line 183, interactive confirm-spec at line 224).
    - Do NOT add a new `testTimeout` in `vitest.config.ts` — the default 5000ms is intentional and sufficient.
    - Do NOT remove the `onceSpy = vi.spyOn(process.stdin, "once")` line — it is load-bearing for the non-regression assertion at line 288.
    - Do NOT remove or rename `runWithTTY` — the interactive sibling test at line 250 also uses it.

    ESM note (CON-runtime-esm): no import changes are required. If any import did change, keep the `.js` extension per the project convention documented in `.claude/skills/typescript/SKILL.md` — e.g. `import { ... } from "../../src/state/project-state.js"`.
  </action>

  <verify>
    <automated>cd /Users/admin/Desktop/AI/Web2/autonomous-dev-system &amp;&amp; npm test -- tests/integration/orchestrator-autonomy.test.ts --run 2>&amp;1 | tail -40</automated>
  </verify>

  <acceptance_criteria>
    1. `cd /Users/admin/Desktop/AI/Web2/autonomous-dev-system && npm test -- tests/integration/orchestrator-autonomy.test.ts --run` exits with status `0` and reports 4 passing tests (budget, resume, interactive confirm-spec, non-interactive confirm-spec). Confirm with `echo $?` → 0.
    2. `cd /Users/admin/Desktop/AI/Web2/autonomous-dev-system && npm test 2>&1 | tail -5` shows the total suite count at 777 passing / 0 failing. Grep proof:
       - `npm test 2>&1 | grep -E "Tests\s+[0-9]+ passed"` shows ≥777 passed and no "failed" count greater than 0.
    3. `cd /Users/admin/Desktop/AI/Web2/autonomous-dev-system && npm run typecheck` exits `0` with zero diagnostics.
    4. `cd /Users/admin/Desktop/AI/Web2/autonomous-dev-system && npm run lint` exits `0`.
    5. Structural grep checks on the edited test file:
       - `grep -n "Promise.race" tests/integration/orchestrator-autonomy.test.ts` returns **no output** (the race block is gone).
       - `grep -n "runOrchestrator timed out waiting for confirm-spec input" tests/integration/orchestrator-autonomy.test.ts` returns **no output** (the custom timeout error message is gone).
       - `grep -c "expect(onceSpy).not.toHaveBeenCalled" tests/integration/orchestrator-autonomy.test.ts` returns **1** (non-regression assertion preserved).
       - `grep -c "expect(mockedRunArchitecture).toHaveBeenCalledTimes(1)" tests/integration/orchestrator-autonomy.test.ts` returns **1** (architecture-called assertion preserved).
       - `grep -n "does not block unattended runs in non-interactive confirm-spec mode" tests/integration/orchestrator-autonomy.test.ts` returns exactly one match at the test's `it(...)` declaration (test name unchanged).
       - `grep -n "await runOrchestrator(state, config)" tests/integration/orchestrator-autonomy.test.ts` returns at least one match inside the non-interactive test body.
    6. `git diff --stat src/` returns **empty output** (no source file changed — proves production code was untouched, confirming the diagnosis).
    7. `git diff --stat tests/` shows exactly one file changed: `tests/integration/orchestrator-autonomy.test.ts` with a net line reduction (roughly `-6` to `-8` lines).
  </acceptance_criteria>

  <done>
    All four ROADMAP Phase 1 success criteria are simultaneously true on a single run:
    1. `npm test` reports 777+/777+ passing with zero failures.
    2. `npm run typecheck` is clean.
    3. `npm run lint` is clean.
    4. No other test file regressed (vitest output shows only expected results).

    And the diagnosis is preserved: `git diff src/` is empty (production code untouched).
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| (none introduced by this phase) | Test-only edit. No new process inputs, network calls, filesystem writes outside `tmpdir()`-scoped test directories, or user-derived content are added or changed. `process.stdin` manipulation is scoped to `runWithTTY` which restores the original descriptor in `finally`. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-01-01 | T (Tampering) | tests/integration/orchestrator-autonomy.test.ts | accept | Test files are not deployed and have no runtime exposure. Integrity is guaranteed by git history + code review. |
| T-01-02 | D (Denial of Service) | Vitest per-test timeout on the edited test | mitigate | The removed 200ms `Promise.race` is replaced by vitest's default 5000ms per-test timeout (`vitest.config.ts` sets no override). A hypothetical regression where `.once` is called on a non-TTY stdin would fail via (a) the existing `expect(onceSpy).not.toHaveBeenCalled()` assertion if the orchestrator eventually resolves, or (b) the 5000ms vitest timeout if the pause is real. Both paths produce an actionable, non-flaky failure. |
| T-01-03 | I (Information disclosure) | Orchestrator console output for confirm-spec path | accept | `src/orchestrator.ts:584-589` logs spec summary + user-story/NFR counts to stdout. This is test-visible but not test-modified; the spec content in these mocked tests is synthetic (`"Build a todo app"`) and contains no secrets. |

**Rationale for security_enforcement compliance:** this is a pure test-file edit that removes a brittle timing guard; no new trust boundaries are crossed, no user-derived content is introduced into prompts, no filesystem write paths are broadened, and no production code is modified. STRIDE register is included per policy with explicit accept/mitigate dispositions rather than "N/A".
</threat_model>

<verification>
Phase-level checks (run after Task 1 completes):

1. **Full test suite green:**
   `cd /Users/admin/Desktop/AI/Web2/autonomous-dev-system && npm test 2>&1 | tail -10` — must show non-zero passing count with zero failures and zero unhandled rejections.

2. **Targeted test file green:**
   `cd /Users/admin/Desktop/AI/Web2/autonomous-dev-system && npm test -- tests/integration/orchestrator-autonomy.test.ts --run 2>&1 | tail -20` — must show 4 passing tests in the `Orchestrator autonomy hardening` describe block.

3. **TypeScript strict-mode clean:**
   `cd /Users/admin/Desktop/AI/Web2/autonomous-dev-system && npm run typecheck` — exit 0, zero diagnostics.

4. **Lint clean:**
   `cd /Users/admin/Desktop/AI/Web2/autonomous-dev-system && npm run lint` — exit 0.

5. **No production-source drift:**
   `git diff --stat src/` — must be empty. Confirms the fix is test-side only per the diagnosis and does not accidentally mutate `src/orchestrator.ts` or any other production file.

6. **Diff scope is single-file, subtractive:**
   `git diff --stat tests/` — must report exactly one modified file (`tests/integration/orchestrator-autonomy.test.ts`) with a net line reduction.
</verification>

<success_criteria>
Phase 1 is complete when all four ROADMAP success criteria hold simultaneously on a fresh checkout:

1. `npm test` reports at minimum 777/777 passing — specifically, the test `does not block unattended runs in non-interactive confirm-spec mode` in `tests/integration/orchestrator-autonomy.test.ts` (line 257 in the current file; line number may shift after the edit) no longer times out.
2. `npm run typecheck` is clean.
3. `npm run lint` is clean.
4. No regression in any other test file — vitest run is fully green.

Additionally, VAL-01 in `.planning/REQUIREMENTS.md` can be checked off and the "one known caveat" language under REQ-confirm-spec-gate in the Validated block can be resolved.
</success_criteria>

<output>
After completion, create `.planning/phases/01-test-readiness-stabilization/01-01-SUMMARY.md` summarizing:
- The exact diff applied (removed `Promise.race` + 200ms timeout; direct `await runOrchestrator`).
- The diagnosis confirmed correct (production code at `src/orchestrator.ts:590-598` unchanged; `git diff src/` empty).
- Final test counts from `npm test` (should be 777/777 or higher).
- Typecheck + lint results (both clean).
- Confirmation that VAL-01 is closed and Phase 2 can begin against a clean baseline.
</output>
