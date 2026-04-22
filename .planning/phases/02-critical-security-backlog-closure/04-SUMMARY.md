---
phase: 02-critical-security-backlog-closure
plan: 04
subsystem: security
tags: [sandbox, allowlist, denylist, self-improve, execFile, SEC-04]

# Dependency graph
requires:
  - phase: 02-critical-security-backlog-closure
    provides: "SDK pinned to 0.2.90 (SEC-01 baseline, wave 1)"
provides:
  - "Two-layer sandbox gate: FORBIDDEN_BINARIES (deny-first) + ALLOWED_EXECUTABLES (allow-second) in runCommandInSandbox"
  - "Exported ReadonlySet<string> for both sets — silent widening surfaces as test diffs"
  - "Regression tests pin allowlist contents + reject curl, rm, bash, python via explicit denylist"
affects: [self-improve, mutation-engine, benchmark-runner, security, SEC-05..SEC-08]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "deny-first / allow-second gate ordering for executable sandboxes"
    - "ReadonlySet<string> export pattern so tests pin configuration against silent widening"

key-files:
  created: []
  modified:
    - src/self-improve/sandbox.ts
    - tests/self-improve/sandbox.test.ts

key-decisions:
  - "Denylist check runs BEFORE allowlist check so future widening of ALLOWED_EXECUTABLES cannot re-enable a known-dangerous binary"
  - "FORBIDDEN_BINARIES mirrors the project's existing risk model from src/hooks/security.ts DENY_PATTERNS (shell + network + dangerous fs)"
  - "Distinct error messages per layer ('forbidden binary list' vs 'not an allowed executable') let tests discriminate between the two gates"

patterns-established:
  - "Exported ReadonlySet<string> security sets: tests assert exact contents so PRs widening either set show as a diff in CI"
  - "Deny-first ordering: defense-in-depth gating where the broader denylist runs first, then the narrower allowlist"

requirements-completed: [SEC-04]

# Metrics
duration: 5 min
completed: 2026-04-22
---

# Phase 2 Plan 04: SEC-04 Sandbox FORBIDDEN_BINARIES Summary

**Two-layer executable gate in `runCommandInSandbox` — FORBIDDEN_BINARIES denylist (curl, wget, sh/bash/zsh/dash, rm/dd/mkfs, sudo/chmod/chown, scp/ssh, eval, perl/python/python3/ruby) runs before the ALLOWED_EXECUTABLES allowlist, both exported as `ReadonlySet<string>` and pinned by 6 new regression tests.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-04-22T17:29:11Z
- **Completed:** 2026-04-22T17:34:17Z
- **Tasks:** 3
- **Files modified:** 2

## Accomplishments
- Added explicit `FORBIDDEN_BINARIES` denylist (19 entries) to the mutation sandbox.
- Converted both `ALLOWED_EXECUTABLES` and `FORBIDDEN_BINARIES` to exported `ReadonlySet<string>` so tests can pin contents.
- Reordered the gate to deny-first / allow-second — future widening of the allowlist cannot silently re-enable a known-dangerous binary.
- Added 6 regression tests in `tests/self-improve/sandbox.test.ts`: pin-the-allowlist, denylist-contents, curl/rm/bash/python rejection cases, and a layer-2 unknown-exec case.
- Full suite: 807/807 tests passing; typecheck green; lint clean.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add FORBIDDEN_BINARIES denylist + export both sets, deny-first ordering** — `6bf8dbc` (feat)
2. **Task 2: Add SEC-04 regression tests (pin allowlist + 4 rejection cases)** — `ef40a77` (test)
3. **Task 3: Typecheck + run sandbox tests + full suite** — verification-only, no commit

## Files Created/Modified
- `src/self-improve/sandbox.ts` — exported both sets as `ReadonlySet<string>`, added FORBIDDEN_BINARIES, reordered gate to deny-first.
- `tests/self-improve/sandbox.test.ts` — added `describe("SEC-04 sandbox executable allowlist + denylist", ...)` block with 6 new tests.

## Diff Slice — sandbox.ts

```ts
// Before (lines 6–8)
const ALLOWED_EXECUTABLES = new Set([
  'npm', 'npx', 'tsc', 'vitest', 'node', 'git',
]);

// After (lines 6–30)
/**
 * SEC-04: Allowlist for executables runnable inside the mutation sandbox.
 * Exported (read-only) so regression tests can assert exact contents — silent
 * widening shows up as a test diff. Pair with FORBIDDEN_BINARIES below for
 * defense-in-depth (deny-first ordering).
 */
export const ALLOWED_EXECUTABLES: ReadonlySet<string> = new Set([
  'npm', 'npx', 'tsc', 'vitest', 'node', 'git',
]);

/**
 * SEC-04: Defense-in-depth denylist. Even if a future maintainer widens
 * ALLOWED_EXECUTABLES, none of these binaries may be invoked from the
 * mutation worktree. Mirrors the high-risk surface in src/hooks/security.ts
 * DENY_PATTERNS (shell + network + dangerous fs).
 */
export const FORBIDDEN_BINARIES: ReadonlySet<string> = new Set([
  'curl', 'wget',
  'sh', 'bash', 'zsh', 'dash',
  'rm', 'dd', 'mkfs',
  'sudo', 'chmod', 'chown',
  'scp', 'ssh',
  'eval',
  'perl', 'python', 'python3', 'ruby',
]);
```

```ts
// Gate — runCommandInSandbox, now deny-first / allow-second (lines 91–113)
  // SEC-04 layer 1 — explicit denylist runs first so a future allowlist widening
  // cannot accidentally re-enable a known-dangerous binary.
  if (FORBIDDEN_BINARIES.has(executable)) {
    return Promise.resolve({
      success: false,
      output: "",
      error: `Blocked: '${executable}' is on the SEC-04 forbidden binary list`,
      exitCode: 1,
      durationMs: 0,
    });
  }

  // SEC-04 layer 2 — explicit allowlist for everything else. Reject anything
  // not on the small known-good set.
  if (!ALLOWED_EXECUTABLES.has(executable)) {
    return Promise.resolve({
      success: false,
      output: "",
      error: `Blocked: '${executable}' is not an allowed executable. Allowed: ${[...ALLOWED_EXECUTABLES].join(', ')}`,
      exitCode: 1,
      durationMs: 0,
    });
  }
```

## New describe block — sandbox.test.ts

```ts
describe("SEC-04 sandbox executable allowlist + denylist", () => {
  it("pins ALLOWED_EXECUTABLES to the known-safe set", ...);
  it("includes shell + network + dangerous-fs binaries in FORBIDDEN_BINARIES", ...);
  it("blocks 'curl' via FORBIDDEN_BINARIES with the layer-1 message", ...);
  it("blocks 'rm' via FORBIDDEN_BINARIES with the layer-1 message", ...);
  it("blocks 'bash' via FORBIDDEN_BINARIES (defense even if allowlist were widened)", ...);
  it("blocks 'python' via FORBIDDEN_BINARIES", ...);
  it("blocks an unknown executable 'fooexec' via the layer-2 allowlist message", ...);
});
```

All 6 new tests green; 7 pre-existing sandbox tests still green. Full suite 807/807.

## Callsite Report (grep proving deny-first ordering)

```
src/self-improve/sandbox.ts:12:export const ALLOWED_EXECUTABLES: ReadonlySet<string> = new Set([
src/self-improve/sandbox.ts:22:export const FORBIDDEN_BINARIES: ReadonlySet<string> = new Set([
src/self-improve/sandbox.ts:93:  if (FORBIDDEN_BINARIES.has(executable)) {          ← layer 1 (deny first)
src/self-improve/sandbox.ts:105:  if (!ALLOWED_EXECUTABLES.has(executable)) {       ← layer 2 (allow second)
src/self-improve/sandbox.ts:109:      error: `Blocked: '${executable}' is not an allowed executable. Allowed: ${[...ALLOWED_EXECUTABLES].join(', ')}`,
tests/self-improve/sandbox.test.ts:17:  ALLOWED_EXECUTABLES,
tests/self-improve/sandbox.test.ts:18:  FORBIDDEN_BINARIES,
tests/self-improve/sandbox.test.ts:221:  it("pins ALLOWED_EXECUTABLES to the known-safe set", ...
tests/self-improve/sandbox.test.ts:222:    expect([...ALLOWED_EXECUTABLES].sort()).toEqual(...
tests/self-improve/sandbox.test.ts:227:  it("includes shell + network + dangerous-fs binaries in FORBIDDEN_BINARIES", ...
tests/self-improve/sandbox.test.ts:229:      expect(FORBIDDEN_BINARIES.has(bad)).toBe(true);
tests/self-improve/sandbox.test.ts:233:  it("blocks 'curl' via FORBIDDEN_BINARIES with the layer-1 message", ...
tests/self-improve/sandbox.test.ts:242:  it("blocks 'rm' via FORBIDDEN_BINARIES with the layer-1 message", ...
tests/self-improve/sandbox.test.ts:248:  it("blocks 'bash' via FORBIDDEN_BINARIES (defense even if allowlist were widened)", ...
tests/self-improve/sandbox.test.ts:254:  it("blocks 'python' via FORBIDDEN_BINARIES", ...
```

Deny-first ordering is confirmed: line 93 (FORBIDDEN_BINARIES.has) executes before line 105 (ALLOWED_EXECUTABLES.has).

## Verification Results

| Check | Result |
|-------|--------|
| `grep "export const ALLOWED_EXECUTABLES: ReadonlySet" src/self-improve/sandbox.ts` | 1 match (line 12) |
| `grep "export const FORBIDDEN_BINARIES: ReadonlySet" src/self-improve/sandbox.ts` | 1 match (line 22) |
| Deny-first (FORBIDDEN_BINARIES.has line < ALLOWED_EXECUTABLES.has line) | 93 < 105 PASS |
| `grep -c "SEC-04 sandbox executable allowlist" tests/self-improve/sandbox.test.ts` | 1 match |
| `grep -c "FORBIDDEN_BINARIES" tests/self-improve/sandbox.test.ts` | 7 matches |
| `npm run typecheck` | 0 errors |
| `npm test` (full suite) | 79 files / 807 tests passed |
| `npm run lint` | clean |
| `npm test -- --run tests/self-improve/sandbox.test.ts` | 13 passed (7 pre-existing + 6 new) |

## Decisions Made

- **Denylist runs before allowlist.** This defense-in-depth ordering is the whole point of the plan — protect against a future maintainer widening `ALLOWED_EXECUTABLES` to fix a benchmark and silently re-enabling shell-out.
- **FORBIDDEN_BINARIES content.** Adopted the plan's explicit list: curl, wget, sh, bash, zsh, dash, rm, dd, mkfs, sudo, chmod, chown, scp, ssh, eval, perl, python, python3, ruby. Mirrors the project's existing risk model from `src/hooks/security.ts` DENY_PATTERNS.
- **Distinct layer error messages.** Kept existing `Blocked: '...' is not an allowed executable. Allowed: ...` for layer 2; added new `Blocked: '...' is on the SEC-04 forbidden binary list` for layer 1. Tests discriminate between the two.
- **No changes to `runInWorktreeSandbox`.** Worktree creation uses `execFile("git", ...)` directly with a hard-coded (non-LLM-derived) binary name, so the gate is not required there.

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

- Repository working tree had pre-existing unrelated modifications (`src/self-improve/mutation-engine.ts`, `src/state/memory-store.ts`, `src/utils/config.ts`) and sibling phase 2 plan files staged but not committed. Handled per scope rules: staged only the files modified by SEC-04 (`src/self-improve/sandbox.ts`, `tests/self-improve/sandbox.test.ts`), left all other files untouched.

## User Setup Required

None — no external service configuration required. The change is purely code-level hardening inside the mutation sandbox.

## Next Phase Readiness

- SEC-04 mitigated. Mutation pipeline sandbox is now defense-in-depth hardened.
- Ready for next wave-2 SEC plans (05–08).
- No blockers; no architectural surface was added.

## Self-Check: PASSED

- FOUND: `src/self-improve/sandbox.ts` (FORBIDDEN_BINARIES + ALLOWED_EXECUTABLES exported, deny-first gate at lines 93/105)
- FOUND: `tests/self-improve/sandbox.test.ts` (6 new SEC-04 tests)
- FOUND commit: `6bf8dbc` (feat sandbox)
- FOUND commit: `ef40a77` (test sandbox)
- PASS: `npm run typecheck` clean
- PASS: `npm test` 807/807
- PASS: `npm run lint` clean

---
*Phase: 02-critical-security-backlog-closure*
*Completed: 2026-04-22*
