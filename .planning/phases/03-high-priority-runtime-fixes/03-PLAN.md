---
phase: 03-high-priority-runtime-fixes
plan: 03
type: execute
wave: 2
depends_on:
  - "01"
files_modified:
  - src/orchestrator.ts
  - src/events/interrupter.ts
  - tests/events/interrupter.test.ts
  - tests/integration/orchestrator-runtime.test.ts
autonomous: true
requirements:
  - HIGH-03
must_haves:
  truths:
    - "Each runOrchestrator() invocation owns its own Interrupter instance AND a SIGINT handler closed over THAT instance (already partially true — keep this invariant)"
    - "The module-level _activeInterrupter fallback is eliminated in favor of a stack (array) of active interrupters; SIGINT delivers to EVERY currently-running orchestrator, not only the most-recently-started one"
    - "getInterrupter() returns the most-recently-pushed active interrupter (LIFO) for back-compat — existing callers (e.g. CLI signal handlers delegating to getInterrupter) keep working"
    - "When an orchestrator finishes its run, its Interrupter is popped from the active stack in the `finally` block; other concurrent runs keep their handlers intact"
    - "A new integration test demonstrates two concurrent runOrchestrator invocations — SIGINT emitted once triggers BOTH runs to enter graceful shutdown (not just one)"
    - "npm run typecheck exits 0"
    - "npm test exits 0 (preserves baseline established by Plan 01 — 811/811 + Plan 01's new tests)"
    - "npm run lint exits 0"
  artifacts:
    - path: "src/orchestrator.ts"
      provides: "Interrupter registry (stack) with push on entry, pop on exit; SIGINT handler loops over all active interrupters"
      contains: "interrupterStack"
    - path: "src/events/interrupter.ts"
      provides: "No change required — Interrupter class itself is already race-safe per-instance. (If any change is needed, it is documentation-only.)"
      contains: "class Interrupter"
    - path: "tests/events/interrupter.test.ts"
      provides: "Unit test asserting two Interrupter instances are independent — interrupting one does not abort the other's signal"
      contains: "independent"
    - path: "tests/integration/orchestrator-runtime.test.ts"
      provides: "Integration test asserting two concurrent runOrchestrator invocations both receive SIGINT and shut down gracefully"
      contains: "parallel"
  key_links:
    - from: "src/orchestrator.ts:63 (module-level state)"
      to: "src/orchestrator.ts:208-214 (per-invocation Interrupter + SIGINT handler)"
      via: "replace `let _activeInterrupter = new Interrupter()` with `const interrupterStack: Interrupter[] = []`; push on entry, pop in finally"
      pattern: "interrupterStack"
    - from: "src/orchestrator.ts exports (getInterrupter)"
      to: "CLI / test callers (e.g. src/index.ts signal wiring)"
      via: "preserve the `export function getInterrupter(): Interrupter` signature; return the top-of-stack"
      pattern: "export function getInterrupter"
---

<objective>
HIGH-03: Fix the `Interrupter` singleton race that drops SIGINT handlers when multiple `runOrchestrator()` invocations are in flight simultaneously. Today `src/orchestrator.ts` holds a module-level `let _activeInterrupter = new Interrupter();` (line 63) that is overwritten by every `runOrchestrator()` start (line 209: `_activeInterrupter = interrupter;`). When two orchestrator runs are alive (e.g. test parallelism, a library consumer that wraps two sub-workflows, or a future multi-project runner), only the *most-recently-started* run's Interrupter is reachable via `getInterrupter()`, and the other run silently loses the ability to be interrupted via the exported helper. The per-invocation SIGINT listeners (lines 211-214) do still fire correctly because they are closed over the local `interrupter` — so the acute SIGINT delivery case works today for that path. The singleton race hits external callers of `getInterrupter()` plus any future code that dispatches without assuming one-run-at-a-time.

Purpose: Per REQUIREMENTS.md HIGH-03 success criterion #3: "Two parallel `run` invocations install independent `Interrupter` instances; SIGINT to one does not cross-fire to the other (and each run's interrupter is reachable)." The fix: replace the singleton with an **active-interrupter stack** (array). `runOrchestrator()` pushes its Interrupter on entry and pops in `finally`. `getInterrupter()` returns the top-of-stack (LIFO — mirrors the current "last-one-wins" semantic for the common single-run case). A module-level process-wide SIGINT handler is installed ONCE (idempotent) and iterates the stack to interrupt every active run.

Output: A registry refactor in `src/orchestrator.ts` (replace the single module-level var with an array + a once-installed process-level SIGINT handler), zero changes in `src/events/interrupter.ts` (the class is already race-safe per-instance), plus two tests — a unit test in `tests/events/interrupter.test.ts` proving instance independence, and an integration test in `tests/integration/orchestrator-runtime.test.ts` proving concurrent runs both shut down on SIGINT.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/REQUIREMENTS.md
@.planning/phases/03-high-priority-runtime-fixes/03-CONTEXT.md
@.claude/skills/typescript/SKILL.md
@src/orchestrator.ts
@src/events/interrupter.ts
@tests/events/interrupter.test.ts
@tests/integration/orchestrator-runtime.test.ts

<interfaces>
<!-- Key contracts the executor needs. Extracted from codebase. -->

From src/events/interrupter.ts (unchanged — already race-safe per-instance):
```typescript
export class Interrupter {
  private controller: AbortController;
  private interrupted = false;
  private reason: string | undefined;
  private redirectPhase: Phase | undefined;

  constructor() { this.controller = new AbortController(); }
  get signal(): AbortSignal { return this.controller.signal; }
  interrupt(reason: string, redirectPhase?: Phase): void;
  isInterrupted(): boolean;
  getReason(): string | undefined;
  getRedirectPhase(): Phase | undefined;
  reset(): void;
  requestShutdown(): void;
}
```

From src/orchestrator.ts (current module state, lines 59-67 — the race surface):
```typescript
// --- Interrupter (scoped per runOrchestrator invocation) ---
let _activeInterrupter = new Interrupter();

export function getInterrupter(): Interrupter {
  return _activeInterrupter;
}
```

From src/orchestrator.ts (current per-run Interrupter wiring, lines 207-214):
```typescript
export async function runOrchestrator(...) {
  const interrupter = new Interrupter();
  _activeInterrupter = interrupter;           // ← overwrites any previous run's reference

  const sigintHandler = () => {
    interrupter.interrupt("SIGINT");          // ← closed over local `interrupter` — OK for this invocation
  };
  process.on("SIGINT", sigintHandler);
  // ...
  } finally {
    process.removeListener("SIGINT", sigintHandler);
    // No corresponding reset of _activeInterrupter — stale reference survives!
```

From tests/integration/orchestrator-runtime.test.ts (existing pattern to copy for the new concurrent test):
- Uses `vi.mock("@anthropic-ai/claude-agent-sdk", ...)`.
- Mocks all phase handlers.
- Calls `runOrchestrator(state, config, undefined, "architecture")` to run a single phase.
- Teardown uses `rmSync(TEST_DIR, { recursive: true })`.

From tests/events/interrupter.test.ts (existing 10+ unit tests, all per-instance):
- Current tests only use ONE Interrupter at a time.
- The new test adds one multi-instance independence assertion.
</interfaces>

<notes_for_executor>
1. **The Interrupter class itself is NOT broken.** It is already race-safe per-instance: each `new Interrupter()` gets its own `AbortController` and state. The race is in `orchestrator.ts`'s module-level *reference*.
2. **Preserve the `getInterrupter(): Interrupter` export signature.** It's imported elsewhere (e.g. CLI signal plumbing). Return the top-of-stack; if empty, return a fresh idle `Interrupter()` as a no-op so callers see a sane non-interrupted signal.
3. **Install the process-level SIGINT handler idempotently.** If `runOrchestrator()` installs its own `sigintHandler` today (line 213), keep that — it's the right pattern. The stack-based handler is a *module-level* handler installed once and left in place; the per-invocation handler is what actually drives the local `interrupter.interrupt()`. To avoid double-interrupt semantics, pick ONE of two designs:
   - **Design A (minimal change, preferred)**: Keep the per-invocation SIGINT handler (line 213) exactly as-is. Add a stack ONLY for `getInterrupter()` to reach the right run. No module-level signal handler. This fixes the "getInterrupter returns wrong run" case without touching the actual signal plumbing.
   - **Design B (heavier)**: Install ONE module-level SIGINT handler that iterates the stack. Remove the per-invocation handlers. Requires more care to avoid double-registration when `runOrchestrator()` is called in a loop.

   **Pick Design A.** It's the minimum fix that satisfies HIGH-03's literal requirement ("SIGINT to one does not cross-fire to the other") — the per-invocation handler already closes over its own `interrupter`, so cross-firing was never the bug; the bug was `getInterrupter()` returning the wrong instance for external callers.
4. **Stack size is bounded by concurrent runs** — in practice 1-4 in realistic workloads. No eviction needed.
5. **TypeScript strict** — `noUncheckedIndexedAccess` means `stack[stack.length - 1]` is `Interrupter | undefined`; narrow before returning.
6. **Tests use vitest `Promise.all([run1, run2])` for the concurrent case.** Both runs use separate `stateDir`s under the shared `TEST_DIR`.
</notes_for_executor>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Replace module-level _activeInterrupter with an active-interrupter stack</name>
  <files>src/orchestrator.ts</files>
  <behavior>
    - A module-level `const interrupterStack: Interrupter[] = []` replaces `let _activeInterrupter = new Interrupter()`.
    - `runOrchestrator()` pushes its local `interrupter` onto the stack AFTER construction and BEFORE installing the per-invocation SIGINT handler.
    - `runOrchestrator()`'s `finally` block pops its own interrupter off the stack (NOT by index — by identity: find and splice the exact instance, in case stack order was disrupted by out-of-order finish).
    - `getInterrupter(): Interrupter` returns the top-of-stack if non-empty; otherwise returns a fresh sentinel `Interrupter()` so external callers never get `undefined`.
    - The per-invocation `process.on("SIGINT", sigintHandler)` block (lines 211-214) is UNCHANGED — each run's SIGINT handler still closes over its own local `interrupter` and fires `interrupter.interrupt("SIGINT")` for that specific instance. Two concurrent runs install two separate listeners; SIGINT fires all listeners; each interrupts its own Interrupter. No cross-fire.
  </behavior>
  <action>
**Edit 1 — Replace the module state (lines 59-67):**

Before:
```ts
// --- Interrupter (scoped per runOrchestrator invocation) ---
// Module-level reference allows external callers (e.g. SIGINT handler) to reach
// the most-recently-started orchestrator's interrupter. Concurrent orchestrators
// each get their own Interrupter instance — getInterrupter() returns the latest one.
let _activeInterrupter = new Interrupter();

export function getInterrupter(): Interrupter {
  return _activeInterrupter;
}
```

After:
```ts
// --- Interrupter registry (stack) ---
// HIGH-03: replaces the former `let _activeInterrupter = new Interrupter()`
// singleton. That singleton was overwritten by every `runOrchestrator()` start,
// so when two orchestrators were in flight the earlier one became unreachable
// via `getInterrupter()`. Now each invocation pushes its own Interrupter onto
// `interrupterStack` in its opening try-setup and pops it in the `finally`
// block (by instance identity, to tolerate out-of-order finish). Per-invocation
// SIGINT handlers (inside runOrchestrator) are unchanged — each listener is
// closed over its own local `interrupter`, so SIGINT fires them all and each
// run interrupts its own Interrupter. No cross-fire.
const interrupterStack: Interrupter[] = [];

/**
 * Returns the most-recently-started orchestrator's Interrupter (top-of-stack).
 * When no orchestrator is running, returns a sentinel idle Interrupter so
 * external callers always get a non-interrupted signal and never an undefined.
 */
export function getInterrupter(): Interrupter {
  const top = interrupterStack[interrupterStack.length - 1];
  return top ?? new Interrupter();
}

// Exported for tests that need to inspect the stack depth. Not part of the
// stable public API — consumers should not rely on this.
export function _getInterrupterStackDepthForTest(): number {
  return interrupterStack.length;
}
```

**Edit 2 — Push onto the stack immediately after the Interrupter is constructed (currently lines 207-209):**

Before:
```ts
  // Each invocation gets its own Interrupter so concurrent runs don't interfere.
  const interrupter = new Interrupter();
  _activeInterrupter = interrupter;

  const sigintHandler = () => {
    interrupter.interrupt("SIGINT");
  };
  process.on("SIGINT", sigintHandler);
```

After:
```ts
  // HIGH-03: Each invocation gets its own Interrupter AND pushes it onto the
  // module-level `interrupterStack` so `getInterrupter()` resolves to the
  // correct instance for concurrent runs (LIFO). The per-invocation SIGINT
  // handler below is closed over the local `interrupter`, so SIGINT cannot
  // cross-fire between concurrent orchestrators.
  const interrupter = new Interrupter();
  interrupterStack.push(interrupter);

  const sigintHandler = () => {
    interrupter.interrupt("SIGINT");
  };
  process.on("SIGINT", sigintHandler);
```

**Edit 3 — Pop from the stack in the outer `finally` block (currently lines 619-636):**

Before (the outer `finally` — search for `process.removeListener("SIGINT", sigintHandler);`):
```ts
  } finally {
    process.removeListener("SIGINT", sigintHandler);
    try {
      unsubLedger();
    } catch {
      // ignore
    }
    // ... ledger persist, dispose, flush ...
  }
```

After:
```ts
  } finally {
    process.removeListener("SIGINT", sigintHandler);
    // HIGH-03: remove THIS run's interrupter from the stack by identity
    // (not by index) to tolerate out-of-order completion of concurrent runs.
    const idx = interrupterStack.indexOf(interrupter);
    if (idx !== -1) interrupterStack.splice(idx, 1);
    try {
      unsubLedger();
    } catch {
      // ignore
    }
    // ... existing cleanup unchanged ...
  }
```

**Self-check:**
- `grep -n "_activeInterrupter" src/orchestrator.ts` returns ZERO matches (the old singleton name is gone).
- `grep -n "interrupterStack" src/orchestrator.ts` returns 3+ matches (declaration, push, splice).
- `grep -n "export function getInterrupter" src/orchestrator.ts` still returns exactly 1 — signature preserved.
- The per-invocation `process.on("SIGINT", sigintHandler)` line (originally 214) is byte-for-byte unchanged.
  </action>
  <verify>
    <automated>npm run typecheck && test $(grep -c "_activeInterrupter" src/orchestrator.ts) -eq 0 && grep -c "interrupterStack" src/orchestrator.ts | awk '$1 >= 3 { exit 0 } { exit 1 }' && grep -c "export function getInterrupter" src/orchestrator.ts | awk '$1 == 1 { exit 0 } { exit 1 }'</automated>
  </verify>
  <done>
- The module-level `_activeInterrupter` var is fully replaced by `interrupterStack`.
- `runOrchestrator()` pushes on entry, pops by identity in `finally`.
- `getInterrupter()` returns top-of-stack or a fresh idle sentinel.
- `npm run typecheck` exits 0.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Unit test — two Interrupter instances are independent</name>
  <files>tests/events/interrupter.test.ts</files>
  <behavior>
    - New test `'two Interrupter instances have independent signals (HIGH-03)'`: construct `a = new Interrupter()` and `b = new Interrupter()`. Call `a.interrupt("reason-a")`. Assert `a.isInterrupted() === true`, `a.signal.aborted === true`, and `b.isInterrupted() === false`, `b.signal.aborted === false`. Then call `b.interrupt("reason-b")` and verify `a.getReason() === "reason-a"` still (not "reason-b" — no cross-contamination).
  </behavior>
  <action>
Append to the existing `describe("Interrupter", ...)` block in `tests/events/interrupter.test.ts`:

```ts
it("two Interrupter instances have independent signals (HIGH-03)", () => {
  const a = new Interrupter();
  const b = new Interrupter();

  // Interrupting `a` MUST NOT affect `b`.
  a.interrupt("reason-a");

  expect(a.isInterrupted()).toBe(true);
  expect(a.signal.aborted).toBe(true);
  expect(a.getReason()).toBe("reason-a");

  expect(b.isInterrupted()).toBe(false);
  expect(b.signal.aborted).toBe(false);
  expect(b.getReason()).toBeUndefined();

  // Now interrupt `b` and assert the reasons still don't cross.
  b.interrupt("reason-b");
  expect(a.getReason()).toBe("reason-a"); // unchanged
  expect(b.getReason()).toBe("reason-b");
});
```

**Self-check:**
- `grep -c "HIGH-03" tests/events/interrupter.test.ts` returns ≥ 1.
- The new `it(...)` block is inside the existing `describe("Interrupter", ...)`.
  </action>
  <verify>
    <automated>npm test -- --run tests/events/interrupter.test.ts</automated>
  </verify>
  <done>
- The per-instance independence assertion is in place.
- `tests/events/interrupter.test.ts` passes.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Integration test — two concurrent runOrchestrator invocations both shut down on SIGINT</name>
  <files>tests/integration/orchestrator-runtime.test.ts</files>
  <behavior>
    - New test `'two concurrent runOrchestrator invocations each install their own Interrupter and both respond to SIGINT (HIGH-03)'`:
      1. Start `runOrchestrator(state1, config1, undefined, "architecture")` and `runOrchestrator(state2, config2, undefined, "architecture")` in parallel via `Promise.all`. Both use `runArchitecture` mocked to await a `Promise` that never resolves until we manually emit SIGINT.
      2. While both runs are in-flight, invoke `getInterrupter()` and assert `_getInterrupterStackDepthForTest() === 2` (via a newly-exported test hook from orchestrator.ts).
      3. Emit `process.emit("SIGINT")` ONCE.
      4. Await both promises; assert BOTH runs returned gracefully (their per-invocation SIGINT listeners each interrupted their own Interrupter).
      5. After both finish, assert `_getInterrupterStackDepthForTest() === 0`.
  </behavior>
  <action>
The integration test requires the mocked architecture handler to **block** until SIGINT is observed. The simplest pattern is to mock `runArchitecture` to return a promise that resolves once the handler sees `signal.aborted === true`. The orchestrator passes `interrupter.signal` as `execCtx.signal` (line 688 in orchestrator.ts), so the mock can observe abort.

Append to the existing `describe("Orchestrator runtime matrix", ...)` block in `tests/integration/orchestrator-runtime.test.ts`:

```ts
it("two concurrent runOrchestrator invocations each install their own Interrupter and both respond to SIGINT (HIGH-03)", async () => {
  const { _getInterrupterStackDepthForTest } = await import("../../src/orchestrator.js");

  // Two separate stateDirs so state writes don't collide.
  const DIR1 = join(TEST_DIR, "run1");
  const DIR2 = join(TEST_DIR, "run2");
  mkdirSync(DIR1, { recursive: true });
  mkdirSync(DIR2, { recursive: true });

  const baseSpec = {
    summary: "S",
    userStories: [],
    nonFunctionalRequirements: [],
    domain: {
      classification: "general",
      specializations: [],
      requiredRoles: [],
      requiredMcpServers: [],
      techStack: [],
    },
  };
  const state1: ProjectState = {
    ...createInitialState("concurrent run 1"),
    currentPhase: "architecture",
    spec: baseSpec,
  };
  const state2: ProjectState = {
    ...createInitialState("concurrent run 2"),
    currentPhase: "architecture",
    spec: baseSpec,
  };

  const config1: Config = {
    ...makeConfig({ projectDir: DIR1, stateDir: join(DIR1, ".autonomous-dev") }),
  };
  const config2: Config = {
    ...makeConfig({ projectDir: DIR2, stateDir: join(DIR2, ".autonomous-dev") }),
  };

  // Both mocked architecture handlers await the signal being aborted.
  const handlerInvoked = { run1: false, run2: false };
  const makeHandler = (label: "run1" | "run2") =>
    async (_s: ProjectState, _c: Config, execCtx?: { signal?: AbortSignal } | undefined) => {
      handlerInvoked[label] = true;
      await new Promise<void>((resolve) => {
        if (!execCtx?.signal) return resolve();
        if (execCtx.signal.aborted) return resolve();
        execCtx.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { success: true, state: _s };
    };

  mockedArchitecture.mockImplementationOnce(makeHandler("run1"));
  mockedArchitecture.mockImplementationOnce(makeHandler("run2"));

  // Start both runs in parallel.
  const p1 = runOrchestrator(state1, config1, undefined, "architecture");
  const p2 = runOrchestrator(state2, config2, undefined, "architecture");

  // Wait until both handlers have registered their abort listeners.
  await vi.waitFor(() => {
    expect(handlerInvoked.run1).toBe(true);
    expect(handlerInvoked.run2).toBe(true);
    expect(_getInterrupterStackDepthForTest()).toBe(2);
  }, { timeout: 2000 });

  // Fire SIGINT ONCE — each run's per-invocation listener must interrupt its own Interrupter.
  process.emit("SIGINT");

  // Both runs should complete (their handlers resolved once the signal aborted).
  await expect(Promise.all([p1, p2])).resolves.toBeDefined();

  // Stack is empty — each run popped its interrupter in finally.
  expect(_getInterrupterStackDepthForTest()).toBe(0);
});
```

**Helper imports**: the file already imports `runOrchestrator`, `makeConfig`, `mockedArchitecture`, `mkdirSync`, `join`, `TEST_DIR`, `createInitialState`, `ProjectState`, `Config`, `vi`, `expect`, `describe`, `it`. Do NOT duplicate imports.

**Add the test-only export** (`_getInterrupterStackDepthForTest`) via `await import("../../src/orchestrator.js")` — already covered by the dynamic import in the test body. No static import change needed.

**Self-check:**
- `grep -c "HIGH-03" tests/integration/orchestrator-runtime.test.ts` returns ≥ 1.
- The test registers two SIGINT listeners (one per orchestrator) via the per-invocation handler already in `runOrchestrator`. Firing `process.emit("SIGINT")` delivers to both.
  </action>
  <verify>
    <automated>npm test -- --run tests/integration/orchestrator-runtime.test.ts</automated>
  </verify>
  <done>
- The concurrent-runs test passes against the refactored orchestrator.
- `_getInterrupterStackDepthForTest()` is exported from orchestrator.ts and returns the current stack depth.
- `tests/integration/orchestrator-runtime.test.ts` passes.
  </done>
</task>

<task type="auto">
  <name>Task 4: Full test sweep + lint</name>
  <files>(no files modified — verification-only)</files>
  <action>
1. `npm run typecheck`.
2. `npm test` — full suite must be green. Target count: baseline (811) + Plan 01's new tests (+2) + Plan 02's new tests (+2 if already merged) + Plan 03's new tests (+2) = ≥ 813/815/817 passing depending on which plans have merged into the working tree when this plan executes. This plan's verify step only requires the count to NOT regress below the count immediately before this plan's edits.
3. `npm run lint`.
4. `grep -c "interrupterStack\|_getInterrupterStackDepthForTest" src/orchestrator.ts tests/integration/orchestrator-runtime.test.ts` for SUMMARY traceability.
  </action>
  <verify>
    <automated>npm run typecheck && npm test && npm run lint</automated>
  </verify>
  <done>
- `npm run typecheck` exits 0.
- `npm test` exits 0; test count does not regress vs. pre-edit baseline.
- `npm run lint` exits 0.
- SUMMARY records the grep counts and reconfirms that the per-invocation SIGINT handler (line 213 in orchestrator.ts) was NOT modified.
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| OS SIGINT → Node process | OS-provided signal; untrusted source of delivery timing but not payload |
| Concurrent `runOrchestrator` callers → module-level Interrupter stack | All in-process, same trust domain; race is correctness, not security |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-03-03-01 | Denial of Service | Concurrent run's Interrupter unreachable via `getInterrupter()` | mitigate | Stack-based registry with push/pop-by-identity in `finally`; per-invocation SIGINT handlers remain closure-scoped. |
| T-03-03-02 | Tampering | External caller pushes a fake Interrupter onto the stack | accept | The stack is a module-scoped const; there is no exported mutator. `_getInterrupterStackDepthForTest` is read-only and test-gated by naming convention. |
| T-03-03-03 | Repudiation | Graceful shutdown cost loss | accept | Already tracked as SPEND-01 (`.planning/REQUIREMENTS.md`); out of scope for HIGH-03. |
</threat_model>

<verification>
End-to-end checks for this plan:
- `grep -c "_activeInterrupter" src/orchestrator.ts` = 0
- `grep -c "interrupterStack" src/orchestrator.ts` ≥ 3 (declaration, push, splice)
- `getInterrupter()` export signature unchanged (`grep -cE '^export function getInterrupter\(' src/orchestrator.ts` = 1)
- Per-invocation SIGINT handler still at approximately line 213 with `interrupter.interrupt("SIGINT")` body
- `npm run typecheck && npm test && npm run lint` all green
</verification>

<success_criteria>
- HIGH-03 acceptance criterion #3 holds: two parallel `run` invocations install independent `Interrupter` instances; `getInterrupter()` returns the correct (top-of-stack) instance; SIGINT delivered via `process.emit` propagates to both runs and does not cross-fire semantically.
- The Interrupter class itself is unchanged (it was already race-safe per-instance).
- Test count ≥ prior baseline.
</success_criteria>

<output>
After completion, create `.planning/phases/03-high-priority-runtime-fixes/03-03-SUMMARY.md` with:
- The exact diff of the `_activeInterrupter → interrupterStack` refactor in `src/orchestrator.ts`.
- Confirmation that the per-invocation SIGINT handler block is byte-for-byte unchanged.
- The two new test names and their assertions.
- Reasoning for choosing Design A (retain per-invocation handlers) over Design B (single module-level handler).
- Final test count and confirmation of lint/typecheck clean.
</output>
