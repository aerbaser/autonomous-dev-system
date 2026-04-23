---
phase: 03-high-priority-runtime-fixes
plan: 03
subsystem: runtime-lifecycle
tags:
  - HIGH-03
  - interrupter
  - sigint
  - concurrency
  - race-fix
requirements:
  - HIGH-03
dependency_graph:
  requires:
    - "Phase 3 Plan 01 (HIGH-01) baseline — 828/828 tests passing at 633a0f9"
  provides:
    - "Stack-based Interrupter registry in src/orchestrator.ts — concurrent runOrchestrator() invocations each get their own Interrupter instance reachable via getInterrupter() (LIFO)."
    - "_getInterrupterStackDepthForTest() test hook for asserting push/pop hygiene."
    - "Per-instance independence contract pinned in tests/events/interrupter.test.ts."
    - "Concurrent-shutdown contract pinned in tests/integration/orchestrator-runtime.test.ts."
  affects:
    - src/orchestrator.ts
    - tests/events/interrupter.test.ts
    - tests/integration/orchestrator-runtime.test.ts
tech_stack:
  added: []
  patterns:
    - "Module-level const stack with push-on-entry + pop-by-identity-in-finally (tolerates out-of-order concurrent completion)."
    - "LIFO accessor that falls back to a fresh idle sentinel when empty (callers always get a non-interrupted signal, never undefined)."
    - "Per-invocation SIGINT closure left byte-for-byte unchanged — proves the fix is scoped to the external-accessor race, not the signal plumbing."
key_files:
  created: []
  modified:
    - src/orchestrator.ts
    - tests/events/interrupter.test.ts
    - tests/integration/orchestrator-runtime.test.ts
    - .planning/REQUIREMENTS.md
decisions:
  - "Chose Design A (stack for getInterrupter() + unchanged per-invocation SIGINT handlers) over Design B (single module-level SIGINT iterator). Design A is the minimum fix that satisfies HIGH-03's literal requirement — the per-invocation handler already closes over its own interrupter, so cross-firing was never the bug; the bug was getInterrupter() returning the wrong instance for external callers."
  - "Pop by instance identity (indexOf + splice) rather than by index — tolerates out-of-order completion of concurrent runs."
  - "Sentinel idle Interrupter returned from getInterrupter() when stack is empty — preserves the invariant that callers always get a non-interrupted signal and never undefined."
metrics:
  duration: "≈10 min"
  tasks_completed: 4
  files_modified: 3
  files_created: 0
  commits:
    - "a250d69 — refactor(03-03): replace _activeInterrupter singleton with stack registry (HIGH-03)"
    - "681518d — test(03-03): unit-test Interrupter instance independence (HIGH-03)"
    - "ab3c1fd — test(03-03): integration test for concurrent runOrchestrator + SIGINT (HIGH-03)"
  test_count_before: 828
  test_count_after: 830
  completed_date: 2026-04-22
---

# Phase 3 Plan 03: HIGH-03 Interrupter Singleton Race Fix — Summary

**One-liner:** Replaced the module-level `let _activeInterrupter = new Interrupter()` singleton in `src/orchestrator.ts` with a push/pop `interrupterStack: Interrupter[]` so `getInterrupter()` resolves to the correct instance for concurrent `runOrchestrator()` invocations; per-invocation SIGINT handlers left byte-for-byte unchanged.

## Objective

HIGH-03 per REQUIREMENTS.md success criterion #3: "Two parallel `run` invocations install independent `Interrupter` instances; SIGINT to one does not cross-fire to the other (and each run's interrupter is reachable)."

The `Interrupter` class itself was never broken — each `new Interrupter()` already owns its own `AbortController` and state. The race was in the module-level *reference* in `orchestrator.ts`:

- Line 63 declared `let _activeInterrupter = new Interrupter()`.
- Line 209 (inside `runOrchestrator`) overwrote it: `_activeInterrupter = interrupter`.
- The `finally` block did **not** reset it — stale references survived past a run.

So when two orchestrator runs were alive in parallel, `getInterrupter()` returned only the most-recently-started run's Interrupter; the earlier one was unreachable via the exported helper.

## Refactor diff (src/orchestrator.ts)

### Before (lines 59-67)

```typescript
// --- Interrupter (scoped per runOrchestrator invocation) ---
// Module-level reference allows external callers (e.g. SIGINT handler) to reach
// the most-recently-started orchestrator's interrupter. Concurrent orchestrators
// each get their own Interrupter instance — getInterrupter() returns the latest one.
let _activeInterrupter = new Interrupter();

export function getInterrupter(): Interrupter {
  return _activeInterrupter;
}
```

### After (lines 59-85)

```typescript
// --- Interrupter registry (stack) ---
// HIGH-03: replaces the former module-level singleton reference that was
// overwritten by every `runOrchestrator()` start. When two orchestrators were
// in flight the earlier one became unreachable via `getInterrupter()`.
// Now each invocation pushes its own Interrupter onto `interrupterStack` in
// its opening try-setup and pops it in the `finally` block (by instance
// identity, to tolerate out-of-order finish). Per-invocation SIGINT handlers
// (inside runOrchestrator) are unchanged — each listener is closed over its
// own local `interrupter`, so SIGINT fires them all and each run interrupts
// its own Interrupter. No cross-fire.
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

### Before (per-invocation Interrupter wiring, lines 207-214)

```typescript
  // Each invocation gets its own Interrupter so concurrent runs don't interfere.
  const interrupter = new Interrupter();
  _activeInterrupter = interrupter;

  const sigintHandler = () => {
    interrupter.interrupt("SIGINT");
  };
  process.on("SIGINT", sigintHandler);
```

### After (lines 228-238)

```typescript
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

### Before (outer finally block, line 619-621)

```typescript
  } finally {
    process.removeListener("SIGINT", sigintHandler);
    try {
      unsubLedger();
```

### After

```typescript
  } finally {
    process.removeListener("SIGINT", sigintHandler);
    // HIGH-03: remove THIS run's interrupter from the stack by identity
    // (not by index) to tolerate out-of-order completion of concurrent runs.
    const idx = interrupterStack.indexOf(interrupter);
    if (idx !== -1) interrupterStack.splice(idx, 1);
    try {
      unsubLedger();
```

## Per-invocation SIGINT handler — byte-for-byte unchanged

The SIGINT handler body at the old line 212 and new line 234:

```typescript
    interrupter.interrupt("SIGINT");
```

…is identical. Both `const sigintHandler = () => { interrupter.interrupt("SIGINT"); };` and `process.on("SIGINT", sigintHandler);` are identical. Confirmed via:

```
$ grep -n 'interrupter.interrupt("SIGINT")' src/orchestrator.ts
234:    interrupter.interrupt("SIGINT");
```

The per-invocation handler is closed over the local `interrupter` variable, so two concurrent runs register two separate listeners. A single SIGINT fires both listeners, and each listener calls `interrupt()` on its own Interrupter instance. No cross-fire is structurally possible, which is exactly why Design A (stack for the accessor, unchanged handlers) is sufficient.

## Design choice — why Design A over Design B

The plan offered two designs:

- **Design A (chosen)**: Stack ONLY for `getInterrupter()`. Per-invocation SIGINT handlers unchanged.
- **Design B (rejected)**: Single module-level SIGINT handler that iterates the stack. Remove per-invocation handlers.

Design A was chosen because:

1. **It's the minimum fix.** HIGH-03's literal requirement is "SIGINT to one does not cross-fire to the other (and each run's interrupter is reachable)." Cross-firing was never the actual bug — the per-invocation listener was already closure-scoped and correct. The reachability-via-`getInterrupter()` was the only real defect.
2. **It touches less code.** Design B requires rearchitecting the signal plumbing; Design A is a 3-edit refactor of module state + an identity-based pop. Smaller blast radius, easier to verify.
3. **Double-registration is structurally impossible.** A run cannot accidentally register two handlers for itself — Design B would need a registration flag to avoid that, Design A gets it for free because each run installs exactly one listener.
4. **Symmetry with `withRetry`'s `signal` propagation.** Phase handlers receive `interrupter.signal` via `execCtx.signal`. Design A leaves that path untouched; Design B would need to decide whether the module-level handler's interrupt fires synchronously or via queue (and would affect the timing assertion in the existing `signal aborts in-flight consumeQuery within 100ms` test).

## New tests

### Unit test — tests/events/interrupter.test.ts

`it("two Interrupter instances have independent signals (HIGH-03)", ...)`

Asserts:
- After `a.interrupt("reason-a")`, `a.isInterrupted() === true` and `a.signal.aborted === true` and `a.getReason() === "reason-a"`.
- Simultaneously, `b.isInterrupted() === false`, `b.signal.aborted === false`, `b.getReason() === undefined`.
- After `b.interrupt("reason-b")`, `a.getReason() === "reason-a"` is unchanged (no cross-contamination).

This pins the per-instance independence invariant at the class level — the stack refactor's correctness rests on this being true.

### Integration test — tests/integration/orchestrator-runtime.test.ts

`it("two concurrent runOrchestrator invocations each install their own Interrupter and both respond to SIGINT (HIGH-03)", ...)`

- Start two `runOrchestrator(state, config, undefined, "architecture")` in parallel via two separate stateDirs (`run1/` and `run2/` under `TEST_DIR`).
- Both mocked architecture handlers await `execCtx.signal.aborted` — they will not resolve until SIGINT fires.
- While both runs are in flight, assert `_getInterrupterStackDepthForTest() === 2`.
- Fire `process.emit("SIGINT")` ONCE.
- Both handlers resolve. `Promise.all([p1, p2])` completes.
- After both runs finish, assert `_getInterrupterStackDepthForTest() === 0` (each run popped its own interrupter by identity in `finally`).

Uses the new `_getInterrupterStackDepthForTest()` test hook from orchestrator.ts (dynamic import in the test body).

## Verification grep counts (for traceability)

```
$ grep -c "_activeInterrupter" src/orchestrator.ts
0

$ grep -c "interrupterStack" src/orchestrator.ts
8

$ grep -cE "^export function getInterrupter\(" src/orchestrator.ts
1

$ grep -c "_getInterrupterStackDepthForTest" src/orchestrator.ts
1

$ grep -cE "interrupterStack|_getInterrupterStackDepthForTest" tests/integration/orchestrator-runtime.test.ts
3
```

All verification criteria from the plan are satisfied.

## Final check results

| Command | Result | Notes |
|---------|--------|-------|
| `npm run typecheck` | exit 0 | No type errors |
| `npm test --run` | 830 passed (830) | Baseline was 828; +2 new (unit + integration) |
| `npm run lint` | exit 0 | No lint warnings |

## Deviations from Plan

None — plan executed exactly as written. Task 1's inline comment originally mentioned the legacy identifier in prose; it was trimmed so the self-check `grep -c "_activeInterrupter" src/orchestrator.ts = 0` passes literally, per the plan's verification contract. That's a doc-comment tweak within the same task, not a deviation in behavior.

One note on test timing: the pre-existing `signal aborts in-flight consumeQuery within 100ms` test in `tests/events/interrupter.test.ts` is flaky under heavy concurrent vitest load (it uses a 100ms budget for abort propagation). It passed on both the per-file re-run and the full-suite run (`830 passed`). This is not caused by and not affected by HIGH-03 work.

## Threat Flags

None. The refactor narrows an existing runtime surface (a module-level mutable singleton) to a module-scoped const with only read-only exports. No new network, auth, or file-system paths introduced.

## Commits

```
a250d69 refactor(03-03): replace _activeInterrupter singleton with stack registry (HIGH-03)
681518d test(03-03): unit-test Interrupter instance independence (HIGH-03)
ab3c1fd test(03-03): integration test for concurrent runOrchestrator + SIGINT (HIGH-03)
```

## Self-Check: PASSED

**Files verified present:**
- `src/orchestrator.ts` — modified, stack registry in place
- `tests/events/interrupter.test.ts` — modified, unit test added
- `tests/integration/orchestrator-runtime.test.ts` — modified, integration test added
- `.planning/REQUIREMENTS.md` — HIGH-03 checkbox marked `[x]`, traceability row updated to Complete
- `.planning/phases/03-high-priority-runtime-fixes/03-SUMMARY.md` — this file

**Commits verified present in git log:**
- `a250d69` — present (`git log --oneline | grep a250d69`)
- `681518d` — present
- `ab3c1fd` — present
