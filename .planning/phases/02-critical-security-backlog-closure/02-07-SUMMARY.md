---
phase: 02-critical-security-backlog-closure
plan: 07
subsystem: security
tags: [security, path-traversal, SEC-07, hardening]
dependency_graph:
  requires:
    - src/state/project-state.ts#assertSafePath (existing root-validation helper)
  provides:
    - src/state/project-state.ts#assertSafeWritePath (new child-path validator)
  affects:
    - src/state/memory-store.ts
    - src/agents/registry.ts
    - src/events/event-logger.ts
    - src/state/run-ledger.ts
    - src/runtime/ask-user.ts
tech_stack:
  added: []
  patterns:
    - "Defense-in-depth: per-subsystem write-boundary assertion complementing existing stateDir root validation"
    - "Prefix-substring aliasing guard (`+ '/'` in startsWith) pinned by dedicated regression test"
key_files:
  created:
    - .planning/phases/02-critical-security-backlog-closure/02-07-SUMMARY.md
  modified:
    - src/state/project-state.ts
    - src/state/memory-store.ts
    - src/agents/registry.ts
    - src/events/event-logger.ts
    - src/state/run-ledger.ts
    - src/runtime/ask-user.ts
    - tests/state/project-state.test.ts
decisions:
  - "Helper uses string-based containment check (`resolve(target).startsWith(resolve(stateDir) + '/')`) matching existing `assertSafePath` style for consistency. The `+ '/'` is load-bearing — rejects prefix-aliased siblings like `stateDir-evil`."
  - "Wired at natural chokepoints (constructor OR first-write function) rather than every individual write call — one assertion per module, not noise-level wrapping."
  - "Helper signature is `(stateDir, target) => void` (throws on violation), not `boolean`. Matches `assertSafePath` contract; callers want fail-fast."
metrics:
  duration_seconds: 435
  duration_human: "7 min"
  tasks_completed: 4
  files_modified: 7
  completed_date: "2026-04-22"
requirements: [SEC-07]
---

# Phase 02 Plan 07: SEC-07 assertSafeWritePath Wiring Summary

Introduced an exported `assertSafeWritePath(stateDir, target)` helper in `src/state/project-state.ts` that validates child paths resolve inside the stateDir subtree, and wired it into 5 high-value write boundaries (memory-store, agents registry, event-logger, run-ledger, ask-user) so future user-derived ID/topic/agent-name segments cannot smuggle `../../etc/passwd` through path concatenation.

## Plan → Outcome

| Task | Status   | Commit    | Notes                                                               |
| ---- | -------- | --------- | ------------------------------------------------------------------- |
| 1    | complete | `b6d67e8` | Added `assertSafeWritePath` adjacent to existing `assertSafePath`   |
| 2    | complete | `2da8f59` | Wired 5 boundary sites (6 callsites total — memory-store has 2)     |
| 3    | complete | `9e2c5bd` | 6 regression tests, including the prefix-substring aliasing guard   |
| 4    | complete | (verify)  | `npm run typecheck`, `npm run lint`, `npm test` all green (811/811) |

## New helper (`src/state/project-state.ts` diff slice)

```ts
/**
 * SEC-07: Validate that a target path resolves INSIDE the stateDir subtree.
 * Use this at write-boundaries of any subsystem that constructs child paths
 * under .autonomous-dev/ — prevents an attacker-supplied id/topic/agent-name
 * segment from smuggling `../../etc/passwd` through path concatenation.
 *
 * Accepts exact equality (target === stateDir root) and strict subpath.
 * Rejects any resolved path that escapes the stateDir with a thrown Error.
 *
 * Complements assertSafePath (which validates the stateDir root). Call sites
 * that already call assertSafePath(stateDir) on construction should additionally
 * call assertSafeWritePath(stateDir, childPath) when they materialize a
 * user-derived path under the stateDir.
 */
export function assertSafeWritePath(stateDir: string, target: string): void {
  const resolvedRoot = resolve(stateDir);
  const resolvedTarget = resolve(target);
  if (
    resolvedTarget !== resolvedRoot &&
    !resolvedTarget.startsWith(resolvedRoot + "/")
  ) {
    throw new Error(
      `Path traversal detected: "${target}" resolves outside state directory "${stateDir}"`
    );
  }
}
```

## Boundary sites wired

| # | Module                          | Chokepoint                        | Assertion                                               |
| - | ------------------------------- | --------------------------------- | ------------------------------------------------------- |
| 1 | `src/state/memory-store.ts`     | `MemoryStore` constructor         | `memoryDir` + `historyDir` (2 calls)                    |
| 2 | `src/agents/registry.ts`        | `AgentRegistry` constructor       | `persistDir` before `.load()`                           |
| 3 | `src/events/event-logger.ts`    | `EventLogger` constructor         | `eventsDir` immediately before `mkdirSync`              |
| 4 | `src/state/run-ledger.ts`       | `RunLedger.persist(stateDir)`     | `ledgerDir` immediately before `mkdirSync`              |
| 5 | `src/runtime/ask-user.ts`       | `appendRecord()`                  | journal `path` immediately before `mkdirSync`/`append`  |

**No TODO deferrals.** All 5 planned modules accepted the wiring cleanly — each already received or trivially derived `stateDir`.

## Test coverage (`tests/state/project-state.test.ts`)

New `describe("SEC-07 assertSafeWritePath", ...)` block with 6 cases:

1. child path under stateDir — accepted
2. stateDir itself (exact equality) — accepted
3. relative `..` escape — rejected
4. absolute non-subpath (`/etc/passwd`) — rejected
5. **prefix-substring sibling (`stateDir-evil/...`)** — rejected. Load-bearing: pins the `+ '/'` in the `startsWith` check. If this case fails, the helper is missing the trailing separator and is false-positive-accepting aliases.
6. existing `assertSafePath` regression — still accepts absolute `/tmp` and relative `.autonomous-dev`

Uses `mkdtempSync(join(tmpdir(), "sec07-"))` for test isolation — zero pollution of repo root.

## Verification

- `npm run typecheck` — 0 errors
- `npm run lint` — eslint clean
- `npm test` — **811/811 passing** across 79 test files (up from the previous baseline of 793 tests, reflecting SEC-01..SEC-06 growth; all pre-existing tests unaffected).
- Project-state-only slice: 23 tests pass (17 pre-existing + 6 new SEC-07).

## Full callsite traceability (`grep -rn "assertSafeWritePath\|assertSafePath" src/ tests/`)

```
src/state/project-state.ts:34:  export function assertSafePath(stateDir: string): void {
src/state/project-state.ts:58:  export function assertSafeWritePath(stateDir: string, target: string): void {
src/state/project-state.ts:157: assertSafePath(stateDir);       // loadState
src/state/project-state.ts:189: assertSafePath(stateDir);       // saveState
src/state/project-state.ts:308: assertSafePath(stateDir);       // withStateLock
src/state/session-store.ts:57:  assertSafePath(stateDir);
src/state/session-store.ts:69:  assertSafePath(stateDir);
src/state/session-store.ts:77:  assertSafePath(stateDir);
src/state/session-store.ts:89:  assertSafePath(stateDir);
src/state/session-store.ts:116: assertSafePath(resolved);
src/state/memory-store.ts:57:   assertSafePath(stateDir);       // existing
src/state/memory-store.ts:62:   assertSafeWritePath(stateDir, this.memoryDir);   // NEW
src/state/memory-store.ts:63:   assertSafeWritePath(stateDir, this.historyDir); // NEW
src/state/run-ledger.ts:319:    assertSafePath(stateDir);       // existing
src/state/run-ledger.ts:323:    assertSafeWritePath(stateDir, ledgerDir);        // NEW
src/state/run-ledger.ts:399:    assertSafePath(stateDir);       // loadLedger (existing)
src/agents/registry.ts:30:      assertSafeWritePath(stateDir, this.persistDir);  // NEW
src/events/event-logger.ts:48:  assertSafeWritePath(stateDir, eventsDir);        // NEW
src/runtime/ask-user.ts:51:     assertSafePath(stateDir);       // existing
src/runtime/ask-user.ts:54:     assertSafeWritePath(stateDir, path);             // NEW
```

Total: 1 definition + 5 modules wired + 6 new call sites (because memory-store has 2). Grep count ≥ 3 passes, target of 5 modules met.

## Deviations from Plan

None. Plan executed exactly as written:

- 5 of 5 boundary modules accepted the wiring without API friction → no TODO deferrals.
- Helper implementation matched the plan's proposed body verbatim.
- Test suite matched the plan's proposed cases verbatim.
- No Rule 1/2/3 auto-fixes needed — no pre-existing bugs surfaced during the touchpoints.

## Threat model outcome

| Threat ID   | Disposition | Resolution                                                                                                 |
| ----------- | ----------- | ---------------------------------------------------------------------------------------------------------- |
| T-02-07-01  | mitigated   | `assertSafeWritePath` wired into 5 high-value write boundaries; future user-derived IDs are path-pinned.   |
| T-02-07-02  | mitigated   | Prefix-substring aliasing covered by regression test #5 in the new describe block.                         |
| T-02-07-03  | accepted    | Dashboard, claude-md-generator, receipts, audit-logger, improvement-tracker use hard-coded path segments (not user-derived IDs). Helper is exported and available; adoption is a one-line addition when those sites are next touched. No TODO blockers added to those files — they are lower-risk and out of this plan's scope. |

## Known Stubs

None. All changes are production-ready; no placeholder values or TODO deferrals introduced.

## Self-Check: PASSED

- `src/state/project-state.ts#assertSafeWritePath` — FOUND (line 58)
- `src/state/memory-store.ts#assertSafeWritePath` — FOUND (lines 62, 63)
- `src/agents/registry.ts#assertSafeWritePath` — FOUND (line 30)
- `src/events/event-logger.ts#assertSafeWritePath` — FOUND (line 48)
- `src/state/run-ledger.ts#assertSafeWritePath` — FOUND (line 323)
- `src/runtime/ask-user.ts#assertSafeWritePath` — FOUND (line 54)
- `tests/state/project-state.test.ts#SEC-07 describe block` — FOUND (line 357)
- Commit `b6d67e8` (helper) — FOUND in git log
- Commit `2da8f59` (5-site wiring) — FOUND in git log
- Commit `9e2c5bd` (tests) — FOUND in git log
