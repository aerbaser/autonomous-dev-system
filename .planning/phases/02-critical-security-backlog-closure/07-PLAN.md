---
phase: 02-critical-security-backlog-closure
plan: 07
type: execute
wave: 2
depends_on:
  - "01"
files_modified:
  - src/state/project-state.ts
  - tests/state/project-state.test.ts
autonomous: true
requirements:
  - SEC-07
must_haves:
  truths:
    - "A new exported helper `assertSafeWritePath(stateDir, target)` is available from src/state/project-state.ts"
    - "assertSafeWritePath validates that `resolve(target)` starts with `resolve(stateDir) + '/'` (or equals it) — target paths escaping the stateDir subtree throw"
    - "The existing `assertSafePath(stateDir)` remains in place and continues to validate the stateDir root; the new helper covers child write sites"
    - "Write sites that already live INSIDE the stateDir by construction (e.g. memory-store, run-ledger, session-store, receipts, events, ask-user, agents registry) document their safety inline by calling `assertSafeWritePath(stateDir, pathToWrite)` at least once at the boundary (constructor OR first write)"
    - "Regression tests cover: (a) absolute path inside stateDir accepted, (b) relative path with '..' rejected, (c) path escaping stateDir via symlink-style traversal rejected, (d) path equal to stateDir accepted"
    - "npm run typecheck and npm test stay green"
  artifacts:
    - path: "src/state/project-state.ts"
      provides: "Exported assertSafeWritePath helper + existing assertSafePath"
      contains: "export function assertSafeWritePath"
    - path: "tests/state/project-state.test.ts"
      provides: "Path traversal regression coverage"
      contains: "assertSafeWritePath"
  key_links:
    - from: "src/state/project-state.ts#assertSafeWritePath"
      to: "node:path#resolve"
      via: "resolve(target).startsWith(resolve(stateDir) + '/')"
      pattern: "assertSafeWritePath"
    - from: "src/state/memory-store.ts + src/agents/registry.ts + src/events/event-logger.ts + etc."
      to: "src/state/project-state.ts#assertSafeWritePath"
      via: "Called at constructor or first-write boundary"
      pattern: "assertSafeWritePath"
---

<objective>
SEC-07: Extend path-traversal hardening to every write site under `.autonomous-dev/`, not just the existing `stateDir` root validation.

Today's coverage: `src/state/project-state.ts` exports `assertSafePath(stateDir)` (lines 34 to 42). Call sites that use it: `loadState`, `saveState`, `withStateLock`, and `MemoryStore` constructor. These cover the *root* path. But every individual write site (memory docs, history jsonl, receipts, events, agents registry, ask-user journal, audit log, improvement tracker) constructs child paths via `join`/`resolve` from a safe root — and today there is no explicit assertion that the constructed child path stays under the stateDir subtree.

This plan introduces a second, finer-grained helper `assertSafeWritePath(stateDir, target)` that validates a target path is contained within stateDir (after both are resolved). It is called at the *boundary* of each subsystem that writes to `.autonomous-dev/` — not on every individual write (that would be noise), but at least once per module at a natural chokepoint (constructor or first-write entry function) so that an attacker-supplied topic/id/agent-name string cannot smuggle `../../../etc/passwd` into a write path.

Scope limit: This plan does NOT rewrite every write call across the codebase. It (a) adds the exported helper, (b) wires it into 5 high-value boundaries identified below (memory-store, agents registry, event-logger, run-ledger, ask-user), (c) adds tests that prove the helper correctly rejects traversal and accepts legitimate paths. Other write sites (development-runner receipts, claude-md-generator, mcp-manager, dashboard generator, audit-logger, improvement-tracker) are in-scope for follow-up if they accept user-derived ID segments, but this plan does not force the rewrite — the new helper is a one-line addition each when those subsystems are visited.

Purpose: Provide a reusable, test-pinned helper so future refactors and the above 5 high-value boundaries are explicitly locked against path-traversal. Today, `memory-store.write(topic, ...)` trusts callers not to pass `../../../etc/passwd` as the *id* — not a current realistic attack (id is a randomUUID), but the hardening is cheap and eliminates a whole class of future regressions.

Output: `project-state.ts` with exported `assertSafeWritePath`, wired in 5 boundary sites; `project-state.test.ts` with regression tests.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/REQUIREMENTS.md
@.planning/intel/constraints.md
@.planning/phases/02-critical-security-backlog-closure/02-CONTEXT.md
@src/state/project-state.ts
@src/state/memory-store.ts
@src/state/run-ledger.ts
@src/state/session-store.ts
@src/agents/registry.ts
@src/events/event-logger.ts
@src/runtime/ask-user.ts
@.claude/skills/typescript/SKILL.md

<interfaces>
Current assertSafePath (src/state/project-state.ts, lines 34 to 42):
```ts
export function assertSafePath(stateDir: string): void {
  if (!isAbsolute(stateDir)) {
    const resolved = resolve(stateDir);
    const base = process.cwd();
    if (!resolved.startsWith(base + "/") && resolved !== base) {
      throw new Error(`Path traversal detected: "${stateDir}" resolves outside project root`);
    }
  }
}
```

Existing imports at top of src/state/project-state.ts:
```ts
import { resolve, dirname, isAbsolute, join } from "node:path";
```

Five boundary sites to wire the new helper through (one line each):

1. src/state/memory-store.ts — constructor already calls `assertSafePath(stateDir)` on line 40. Add a sibling line that also validates `this.memoryDir` and `this.historyDir` are contained within stateDir (they are by construction via `resolve(stateDir, "memory")`, but the assert documents the invariant).

2. src/agents/registry.ts — look for `mkdirSync(this.persistDir, ...)` around line 48. Add `assertSafeWritePath(stateDir, this.persistDir)` at constructor entry. If the constructor doesn't accept `stateDir`, derive it from `resolve(this.persistDir, "..")` or pass it in.

3. src/events/event-logger.ts — `mkdirSync(eventsDir, ...)` around line 46. Assert at module entry that `eventsDir` is under `stateDir`.

4. src/state/run-ledger.ts — `mkdirSync(ledgerDir, ...)` around line 322. Assert at the write boundary.

5. src/runtime/ask-user.ts — `mkdirSync(stateDir, ...)` around line 54 + an `appendFileSync` call to the journal. Assert the journal path is under stateDir.

DO NOT rewrite every individual call inside these modules. One assertion per module at a natural chokepoint is sufficient.
</interfaces>

<notes_for_executor>
1. The helper goes in `src/state/project-state.ts` next to the existing `assertSafePath`. Export it so other modules can import it via `import { assertSafeWritePath } from "../state/project-state.js";`.
2. Implementation:
   ```ts
   export function assertSafeWritePath(stateDir: string, target: string): void {
     const resolvedRoot = resolve(stateDir);
     const resolvedTarget = resolve(target);
     // Allow exact equality (target === stateDir root) OR strict subpath.
     if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + "/")) {
       throw new Error(
         `Path traversal detected: "${target}" resolves outside state directory "${stateDir}"`
       );
     }
   }
   ```
   Note: uses `"/"` as separator — Node resolve() uses platform separator, but this repo runs on darwin (per env block). If portability matters long-term, use `sep` from `node:path`, but the existing `assertSafePath` also hardcodes `"/"` (line 38), so match the file's style for consistency.
3. For the 5 boundary sites, add ONE `assertSafeWritePath(stateDir, targetPath)` line per module at the natural chokepoint (constructor or first writer function). Do NOT wrap every write call.
4. For boundary sites where stateDir is not immediately available, derive it from an existing variable in that module; do NOT add a new constructor parameter unless it is genuinely missing. Most modules already receive `stateDir` — verify by reading the file once.
5. Strict TypeScript per `.claude/skills/typescript/SKILL.md`. The helper signature is `(stateDir: string, target: string) => void`. No type churn.
6. Tests go in `tests/state/project-state.test.ts`. Use `os.tmpdir()` for a safe base directory to avoid polluting the repo.
7. DO NOT attempt to cover EVERY write site in this plan. The 5 boundaries chosen are the highest-value + already-in-context ones. Other write sites (receipts in development-runner, dashboard HTML, etc.) can adopt the helper incrementally; they are not user-ID-derived and are lower risk.
</notes_for_executor>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add assertSafeWritePath helper to project-state.ts</name>
  <files>src/state/project-state.ts</files>
  <action>
Add the new helper IMMEDIATELY after `assertSafePath` (which ends at line 42 today). Do not modify `assertSafePath` — keep both helpers side by side.

Insert after line 42:
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

Self-check:
- `grep -n "export function assertSafe" src/state/project-state.ts` must return 2 lines: one for `assertSafePath`, one for `assertSafeWritePath`.
- The two helpers must be adjacent (no unrelated code between them).
  </action>
  <verify>
    <automated>grep -c "export function assertSafeWritePath" src/state/project-state.ts &amp;&amp; grep -c "export function assertSafePath" src/state/project-state.ts &amp;&amp; npm run typecheck</automated>
  </verify>
  <done>
- `grep "export function assertSafeWritePath" src/state/project-state.ts` returns one match.
- `grep "export function assertSafePath" src/state/project-state.ts` still returns one match (existing helper untouched).
- Both helpers are adjacent in the file.
- `npm run typecheck` exits 0.
  </done>
</task>

<task type="auto">
  <name>Task 2: Wire assertSafeWritePath into 5 boundary sites</name>
  <files>src/state/memory-store.ts, src/agents/registry.ts, src/events/event-logger.ts, src/state/run-ledger.ts, src/runtime/ask-user.ts</files>
  <action>
For each of the 5 modules below, READ the file FIRST to confirm the exact current constructor / write-boundary shape. Then add ONE `assertSafeWritePath(stateDir, <childPath>)` call at the chokepoint. Add `assertSafeWritePath` to the existing `import { assertSafePath }` statement if present, otherwise add a new import.

1. **src/state/memory-store.ts** — existing constructor calls `assertSafePath(stateDir)` on line 40. Add two more lines immediately after it:
   ```ts
   assertSafeWritePath(stateDir, this.memoryDir);
   assertSafeWritePath(stateDir, this.historyDir);
   ```
   Update the existing import: `import { assertSafePath, assertSafeWritePath } from "./project-state.js";`

2. **src/agents/registry.ts** — inspect the constructor. If it takes a stateDir (or something derivable), add `assertSafeWritePath(stateDir, this.persistDir);` at the end of the constructor (or at the top of the first write method if no constructor). Read the file to see the exact shape. If no stateDir is in context, add the assertion at the first `mkdirSync`/`writeFileSync` call by computing `stateDir = resolve(this.persistDir, "..")`.

3. **src/events/event-logger.ts** — at the module's natural entry point where `eventsDir` is computed, add `assertSafeWritePath(stateDir, eventsDir);` before the first `mkdirSync`. Use the existing `stateDir` variable if available.

4. **src/state/run-ledger.ts** — at the function body containing `mkdirSync(ledgerDir, ...)` (line ~322), add `assertSafeWritePath(stateDir, ledgerDir);` immediately before the mkdir.

5. **src/runtime/ask-user.ts** — at the journal write path near line 54, add `assertSafeWritePath(stateDir, journalPath);` before the append.

Rule: if a module does NOT have clean access to `stateDir`, add a TODO comment at the spot explaining the deferral and proceed WITHOUT modifying the module; record in SUMMARY. Do not force an API change in this plan — the plan's scope is to introduce the helper and wire it where it cleanly fits. If fewer than 5 sites are wired because of API friction, that's acceptable; minimum 2 sites wired (memory-store + one other).

Self-check:
- `grep -rn "assertSafeWritePath" src/ --include="*.ts"` must return ≥ 3 lines total (1 definition + ≥ 2 call sites).
- `npm run typecheck` clean after all edits.
  </action>
  <verify>
    <automated>test $(grep -rn "assertSafeWritePath" src/ --include="*.ts" | wc -l) -ge 3 &amp;&amp; npm run typecheck</automated>
  </verify>
  <done>
- `grep -rn "assertSafeWritePath" src/ --include="*.ts"` returns ≥ 3 lines (1 definition + ≥ 2 call sites; target is 5 call sites across the listed modules).
- Each wired module has exactly one additional import for `assertSafeWritePath` (or the existing import is extended).
- Modules where the wiring didn't cleanly fit have an explicit `// TODO(SEC-07): wire assertSafeWritePath when stateDir is plumbed through this module` comment instead of a forced API change, and are disclosed in the SUMMARY.
- `npm run typecheck` exits 0.
  </done>
</task>

<task type="auto">
  <name>Task 3: Add regression tests for assertSafeWritePath</name>
  <files>tests/state/project-state.test.ts</files>
  <action>
READ `tests/state/project-state.test.ts` once to identify helper imports and setup. Then APPEND a new describe block at the end:

```ts
import { assertSafePath, assertSafeWritePath } from "../../src/state/project-state.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// keep other existing imports; dedupe if any overlap

describe("SEC-07 assertSafeWritePath", () => {
  const base = mkdtempSync(join(tmpdir(), "sec07-"));
  const stateDir = join(base, ".autonomous-dev");

  it("accepts a child path under stateDir", () => {
    expect(() => assertSafeWritePath(stateDir, join(stateDir, "memory", "foo.json"))).not.toThrow();
  });

  it("accepts the stateDir itself", () => {
    expect(() => assertSafeWritePath(stateDir, stateDir)).not.toThrow();
  });

  it("rejects a relative '..' escape", () => {
    expect(() => assertSafeWritePath(stateDir, join(stateDir, "..", "etc", "passwd"))).toThrow(/Path traversal/);
  });

  it("rejects an absolute path that is not under stateDir", () => {
    expect(() => assertSafeWritePath(stateDir, "/etc/passwd")).toThrow(/Path traversal/);
  });

  it("rejects a sibling directory that shares a prefix substring (e.g. stateDir-evil)", () => {
    // Guards against a naive `startsWith(stateDir)` without the trailing '/'.
    expect(() => assertSafeWritePath(stateDir, stateDir + "-evil/file.json")).toThrow(/Path traversal/);
  });

  it("existing assertSafePath continues to work (regression)", () => {
    expect(() => assertSafePath("/tmp")).not.toThrow(); // absolute path — allowed
    expect(() => assertSafePath(".autonomous-dev")).not.toThrow(); // relative under cwd — allowed
  });
});
```

Notes for the executor:
- `mkdtempSync` creates an actual temp directory, which is safe for test isolation.
- The "sibling directory with prefix substring" case is load-bearing: it verifies the `+ "/"` in the startsWith check is present. If that test fails, the helper implementation is missing the trailing separator and should be corrected in project-state.ts — that's the point of having the test.
- Do NOT attempt to test the wired call sites in memory-store/registry/etc. here. Those are covered by the individual modules' tests or the broader suite.
  </action>
  <verify>
    <automated>grep -c "SEC-07 assertSafeWritePath" tests/state/project-state.test.ts &amp;&amp; grep -c "stateDir + \"-evil/file.json\"" tests/state/project-state.test.ts</automated>
  </verify>
  <done>
- New describe block `SEC-07 assertSafeWritePath` present in `tests/state/project-state.test.ts`.
- Block contains 6 cases: child accepted, stateDir itself accepted, relative '..' rejected, absolute non-subpath rejected, prefix-substring sibling rejected, existing assertSafePath regression.
- Existing project-state tests untouched.
  </done>
</task>

<task type="auto">
  <name>Task 4: Typecheck + run project-state tests + full suite</name>
  <files>(no files modified — verification-only)</files>
  <action>
1. `npm run typecheck` — must exit 0.
2. `npm test -- --run tests/state/project-state.test.ts` — new SEC-07 cases plus pre-existing cases green.
3. Run the tests for every module that was wired in Task 2 to confirm no regression:
   - `npm test -- --run tests/state/memory-store.test.ts`
   - `npm test -- --run tests/state/run-ledger.test.ts` (if modified)
   - `npm test -- --run tests/events/` (if event-logger was modified)
   - `npm test -- --run tests/agents/registry.test.ts` (if modified)
   - `npm test -- --run tests/runtime/` (if ask-user was modified)
4. `npm test` — full suite green.
5. `grep -rn "assertSafeWritePath\|assertSafePath" src/ tests/ --include="*.ts"` — record full callsite list in SUMMARY.
  </action>
  <verify>
    <automated>npm run typecheck &amp;&amp; npm test</automated>
  </verify>
  <done>
- `npm run typecheck` exits 0.
- `npm test` full green baseline (this covers every impacted subsystem).
- SUMMARY captures the grep output showing all assertSafePath + assertSafeWritePath callsites.
- Any deferrals (modules where wiring didn't fit) are disclosed with the TODO comment's file:line.
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| User-derived ID segment (topic name, agent name, session id) → join() into stateDir path | Any segment used in path concatenation can contain `..` or absolute paths if the input validation is missing. |
| stateDir config value → subsystem constructors | Already validated by `assertSafePath`. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-02-07-01 | Tampering | Write-site path construction under .autonomous-dev/ | mitigate | New `assertSafeWritePath(stateDir, target)` helper; wired at 5 high-value boundaries (memory-store, registry, event-logger, run-ledger, ask-user). |
| T-02-07-02 | Tampering | Prefix-substring aliasing (`stateDir-evil` tricks naive `startsWith`) | mitigate | Helper compares `target.startsWith(stateDir + "/")` — trailing separator prevents the alias. Dedicated test pins this invariant. |
| T-02-07-03 | Tampering | Write sites not covered by this plan (dashboard, claude-md-generator, receipts, etc.) | accept (partial) | These sites use hard-coded path segments, not user-derived IDs. Lower risk. Helper is available for future adoption. Disclosed in SUMMARY. |
</threat_model>

<verification>
End-to-end phase checks for this plan:
- `grep -n "export function assertSafeWritePath" src/state/project-state.ts` returns one match.
- `grep -rn "assertSafeWritePath" src/ --include="*.ts" | wc -l` returns ≥ 3 (definition + ≥ 2 callsites; target 5).
- `tests/state/project-state.test.ts` contains the SEC-07 describe block with 6 cases, all passing.
- `npm run typecheck && npm test` green.
</verification>

<success_criteria>
- Reusable `assertSafeWritePath` helper exported alongside existing `assertSafePath`.
- At least 2 (target: 5) boundary sites wired so a future user-derived ID cannot escape `.autonomous-dev/`.
- Regression tests pin the behavior, including the prefix-aliasing edge case.
- No regression in existing subsystem behavior.
</success_criteria>

<output>
After completion, create `.planning/phases/02-critical-security-backlog-closure/02-07-SUMMARY.md` including:
- Diff slice of `project-state.ts` showing the new helper.
- List of the 5 (or fewer — disclose) modules where the helper was wired.
- Any TODO deferrals with rationale.
- Full `grep -rn "assertSafeWritePath"` output for traceability.
</output>
