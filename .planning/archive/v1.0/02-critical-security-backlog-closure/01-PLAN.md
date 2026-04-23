---
phase: 02-critical-security-backlog-closure
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - package.json
  - package-lock.json
autonomous: true
requirements:
  - SEC-01
must_haves:
  truths:
    - "@anthropic-ai/claude-agent-sdk resolves to a fixed version (0.2.90 or the GHSA-5474-4w2j-mq4c-fixed release) in package.json"
    - "package-lock.json agrees with package.json (no drift)"
    - "npm audit --production reports no high/critical advisories for @anthropic-ai/claude-agent-sdk"
    - "npm run typecheck is clean after install"
    - "npm test is clean (at least the pre-phase-1 green baseline of 777 passes)"
  artifacts:
    - path: "package.json"
      provides: "Pinned SDK version under dependencies"
      contains: "\"@anthropic-ai/claude-agent-sdk\""
    - path: "package-lock.json"
      provides: "Reproducible dependency tree resolving the pinned SDK version"
      contains: "\"@anthropic-ai/claude-agent-sdk\""
  key_links:
    - from: "package.json#dependencies"
      to: "package-lock.json#packages['node_modules/@anthropic-ai/claude-agent-sdk']"
      via: "npm install"
      pattern: "@anthropic-ai/claude-agent-sdk"
    - from: "src/**/*.ts"
      to: "@anthropic-ai/claude-agent-sdk"
      via: "ESM import of query / HookCallback / SDKMessage"
      pattern: "@anthropic-ai/claude-agent-sdk"
---

<objective>
SEC-01: Mitigate SDK CVE GHSA-5474-4w2j-mq4c by pinning `@anthropic-ai/claude-agent-sdk` to a fixed version (`0.2.90` per PRODUCT.md §16, unless a higher patched release is available in the npm registry). The current spec (`package.json`) declares `^0.2.97` which falls inside the vulnerable range.

Purpose: Close the single critical-severity known-vuln advisory that blocks us from running the system against real ideas. This plan is a pure dependency change — no source code under `src/` is modified. It runs first in its own wave so every downstream SEC-02..SEC-08 plan executes against the patched SDK (important because `SDKMessage`, `HookCallback`, and `query` are imported across the codebase and a caret-range update could otherwise shift types under our feet).

Output: Updated `package.json` + `package-lock.json` with the exact pinned SDK version, a clean `npm audit --production`, and a green typecheck.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/REQUIREMENTS.md
@.planning/ROADMAP.md
@.planning/phases/02-critical-security-backlog-closure/02-CONTEXT.md
@package.json
@.claude/skills/typescript/SKILL.md

<interfaces>
<!-- Extracted from package.json so the executor does not need to re-read before editing. -->

Current `dependencies` block (package.json):
```json
{
  "@anthropic-ai/claude-agent-sdk": "^0.2.97",
  "@anthropic-ai/sdk": "^0.86.1",
  "commander": "^14.0.3",
  "zod": "^4.3.6"
}
```

`overrides` block (keep as-is):
```json
{
  "@anthropic-ai/sdk": "^0.86.1"
}
```

Scripts used for verification (already present, do not modify):
- `npm test` → `vitest run`
- `npm run typecheck` → `tsc --noEmit`
- `npm run lint` → `eslint src/`
</interfaces>

<notes_for_executor>
1. **Version selection order**: First attempt to pin to the lowest known-fixed version `0.2.90` (per PRODUCT.md §16 + REQUIREMENTS.md SEC-01 wording "downgrade … to `0.2.90` or pinned to a fixed version"). If `npm view @anthropic-ai/claude-agent-sdk` shows a higher released version that carries a GHSA-5474-4w2j-mq4c fix advisory note in its changelog, prefer that higher patched release instead. Record the chosen version in the SUMMARY with rationale.
2. **Pin exactly, not with a caret**: Replace `^0.2.97` with the exact version string (no `^`, no `~`) so subsequent `npm install` cannot pull an affected patch later. This satisfies "pinned to a fixed version".
3. **Refresh the lockfile**: After editing `package.json`, run `npm install` once so `package-lock.json` regenerates to match. Do not hand-edit the lockfile.
4. **Keep other deps untouched**: This plan touches only the one dependency line in `package.json` and whatever lockfile entries `npm install` naturally refreshes. Do not opportunistically bump zod/commander/etc.
5. **Do not upgrade `@anthropic-ai/sdk` override**: The existing `overrides["@anthropic-ai/sdk"]: "^0.86.1"` is intentional (resolves a transitive conflict). Leave it in place.
</notes_for_executor>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Pin @anthropic-ai/claude-agent-sdk to the GHSA-5474-4w2j-mq4c-fixed version</name>
  <files>package.json, package-lock.json</files>
  <action>
Edit `package.json` → `dependencies["@anthropic-ai/claude-agent-sdk"]`:

Before:
```json
"@anthropic-ai/claude-agent-sdk": "^0.2.97",
```

After (use exact version, no range prefix):
```json
"@anthropic-ai/claude-agent-sdk": "0.2.90",
```

Implementation steps (execute in order):
1. Run `npm view @anthropic-ai/claude-agent-sdk versions --json | tail -20` to confirm `0.2.90` is published. If it is not published, fall back to the lowest published 0.2.x version ≥ 0.2.90 whose GitHub release notes mention GHSA-5474-4w2j-mq4c — prefer the explicit patch over a later feature release to minimize unrelated churn.
2. Use the `Edit` tool to replace the single line in `package.json` dependencies. Use exact equality (no `^`, no `~`).
3. Delete `node_modules` is NOT required. Run `npm install` once at repo root. This rewrites `package-lock.json` to lock the new resolved tree.
4. Run `npm audit --production --json | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const j=JSON.parse(s);const mh=(j.metadata?.vulnerabilities?.critical??0)+(j.metadata?.vulnerabilities?.high??0);console.log('high+critical:',mh);process.exit(mh>0?1:0)})"`. Target: exit code 0.
5. If `npm audit` still reports a GHSA-5474-4w2j-mq4c entry for `@anthropic-ai/claude-agent-sdk`, step back and select a higher patched 0.2.x version per the ordering in `<notes_for_executor>`.

Do **not** touch `overrides["@anthropic-ai/sdk"]` (that is an unrelated pin and breaking it re-introduces a transitive conflict).
  </action>
  <verify>
    <automated>node -e "const p=require('./package.json');const v=p.dependencies['@anthropic-ai/claude-agent-sdk'];if(!/^0\.2\.(9\d|1\d\d)$/.test(v))throw new Error('SDK not pinned to fixed exact version: '+v);console.log('pinned:',v)" && npm audit --production --audit-level=high</automated>
  </verify>
  <done>
- `cat package.json | jq -r '.dependencies["@anthropic-ai/claude-agent-sdk"]'` returns an exact version string (no `^`, no `~`), and that version is ≥ `0.2.90`.
- `npm audit --production --audit-level=high` exits 0.
- `package-lock.json` was updated by `npm install` in the same step (not hand-edited); `git diff package-lock.json` shows only entries reachable from the SDK dependency graph.
- `grep "@anthropic-ai/claude-agent-sdk" package-lock.json | head -1` shows the pinned version resolved in the lock.
  </done>
</task>

<task type="auto">
  <name>Task 2: Verify the pinned SDK does not break the baseline</name>
  <files>(no files modified — verification-only)</files>
  <action>
Run the full verification gate against the downgraded SDK. If anything fails, do **not** roll back silently — capture the failure, surface it in the SUMMARY, and stop. The project enforces strict ESM + `noUncheckedIndexedAccess` (see `.claude/skills/typescript/SKILL.md`) and SDK type surface can shift between minor versions, so the typecheck is the most likely tripwire.

1. `npm run typecheck` — must exit 0.
2. `npm run lint` — must exit 0.
3. `npm test` — must report at least the pre-phase-2 green baseline (Phase 1 closed VAL-01 at 4fc0ce5 with 777/777 green). Regressions caused by SDK type changes (e.g. shifted `SDKMessage`/`HookCallback` shape) must be reported in the SUMMARY with exact file:line — do not patch downstream files from this plan; that is out of scope. If the SDK downgrade requires *trivial* type adaptations (e.g. adding `as const` or re-importing a moved type) and the fix is a ≤3-line change in a single file, apply it and mention it in the SUMMARY. Anything larger must become a new plan.
4. Search for import callsites that might break: `grep -rn "from \"@anthropic-ai/claude-agent-sdk\"" src/ --include="*.ts" | wc -l` — note the import count in the SUMMARY so reviewers can see the blast radius.
  </action>
  <verify>
    <automated>npm run typecheck && npm run lint && npm test</automated>
  </verify>
  <done>
- `npm run typecheck`, `npm run lint`, `npm test` all exit 0.
- If any trivial type adaptation was required, it is disclosed in the SUMMARY with file:line and diff.
- No file outside `package.json` / `package-lock.json` is modified, OR any such adaptation is ≤3 LOC in a single file and explicitly justified by an SDK type-surface change.
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| npm registry → local `node_modules` | Untrusted upstream package crosses here during `npm install`. Integrity enforced by `package-lock.json` checksums. |
| `@anthropic-ai/claude-agent-sdk` → our code | SDK author is the trust root for `query()`, hook types, and tool shapes. A vulnerable version in this boundary is exactly what SEC-01 closes. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-02-01-01 | Tampering | package.json / SDK version range | mitigate | Pin SDK to exact fixed version (no caret); lockfile regenerated; `npm audit` enforced clean. |
| T-02-01-02 | Elevation of Privilege | Vulnerable SDK path (GHSA-5474-4w2j-mq4c) | mitigate | Advisory-fixed version installed; audit report is the evidence. |
| T-02-01-03 | Repudiation | Silent dependency drift across runs | mitigate | Exact pin + lockfile committed means any future drift shows up as a diff in git. |
</threat_model>

<verification>
End-to-end phase checks for this plan:
- `jq -r '.dependencies["@anthropic-ai/claude-agent-sdk"]' package.json` returns an exact version (no `^`, no `~`) that is ≥ `0.2.90`.
- `npm audit --production --audit-level=high` returns exit code 0.
- `npm run typecheck && npm run lint && npm test` all succeed.
</verification>

<success_criteria>
- `@anthropic-ai/claude-agent-sdk` pinned to a GHSA-5474-4w2j-mq4c-fixed release.
- `package-lock.json` is in sync (generated by `npm install`, not hand-edited).
- No regression in the existing test baseline.
- Phase 2 downstream plans (SEC-02..SEC-08) can run against the patched SDK.
</success_criteria>

<output>
After completion, create `.planning/phases/02-critical-security-backlog-closure/02-01-SUMMARY.md` including:
- Chosen SDK version (e.g. `0.2.90`) and rationale.
- `npm audit` output snippet proving no high/critical advisories.
- Any incidental type adaptation (file:line + 3-line rationale) if one was required.
- Import-site count (result of `grep -rn "from \"@anthropic-ai/claude-agent-sdk\"" src/`) for downstream awareness.
</output>
