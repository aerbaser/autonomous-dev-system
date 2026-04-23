---
phase: 02-critical-security-backlog-closure
plan: 08
subsystem: config-security
tags:
  - SEC-08
  - security
  - anthropic-api-key
  - regression-test
  - invariant
requirements:
  - SEC-08
dependency_graph:
  requires:
    - SEC-01 (Phase 2 / Plan 01 — SDK pin baseline)
  provides:
    - Regression-locked invariant that Anthropic API key never enters Config
    - Sentinel enumeration of Config top-level keys for future-PR visibility
  affects:
    - src/utils/config.ts (invariant comment)
    - tests/utils/config.test.ts (SEC-08 regression block)
tech_stack:
  added: []
  patterns:
    - "Zod schema-shape sentinel: Object.keys(ConfigSchema.shape).sort() vs EXPECTED_CONFIG_KEYS literal"
    - "Env-leak sentinel: UUID-stamped ANTHROPIC_API_KEY round-trip through loadConfig + JSON.stringify not-contains"
    - "try/finally env-var save/restore for test isolation"
key_files:
  created: []
  modified:
    - src/utils/config.ts
    - tests/utils/config.test.ts
decisions:
  - "SEC-08 is an audit + lock-in plan: the schema was already correct (no Anthropic key field existed); this plan prevents regression rather than fixes a leak."
  - "EXPECTED_CONFIG_KEYS sentinel list chosen over an automated schema drift detector — keeps the failure visible and forces a PR author to think about SEC-08 when adding a field."
  - "Top-level static imports used for the SEC-08 test block (rather than dynamic awaits like the existing pattern) so the sentinel list check runs even if a top-level module evaluation would fail."
  - "JSON.stringify leak check uses both a UUID-stamped sentinel AND a blanket 'sk-ant-' prefix check to catch both the exact value and any variant with an Anthropic-key shape."
  - "No secret-redaction helper added (scope creep per plan notes 8) — the project does not currently log the Config object, so a redactor would be dead code."
metrics:
  duration_minutes: 7
  tasks_completed: 3
  files_modified: 2
  files_created: 0
  tests_added: 4
  tests_total_after: 811
  completed_at: "2026-04-22T17:36:50Z"
---

# Phase 2 Plan 08: SEC-08 API key audit — env-only — Summary

Audit confirmed and locked in: `src/utils/config.ts` has zero `apiKey`/`anthropicApiKey`/`claudeApiKey`/`ANTHROPIC_API_KEY` field declarations, `loadConfig()` only propagates `POSTHOG_API_KEY` / `GITHUB_TOKEN` / `SLACK_WEBHOOK_URL` from `process.env`, and a new 4-case SEC-08 test block in `tests/utils/config.test.ts` will fail loudly the moment a future PR either (a) adds a secret field to `ConfigSchema` or (b) makes `loadConfig()` pipe `process.env.ANTHROPIC_API_KEY` into the Config object.

## Scope

SEC-08 closes PRODUCT.md §16 / REQUIREMENTS.md SEC-08 — "Anthropic API key removed from any Config field — lives only in process.env; no logged or serialized location". The codebase was already compliant (verified by pre-edit grep); this plan adds the regression barrier.

## Changes

### 1. `src/utils/config.ts`

Added a 22-line JSDoc comment block immediately above `export const ConfigSchema = z.object({`. The comment enumerates forbidden field names (`apiKey` / `anthropicApiKey` / `anthropic_api_key` / `ANTHROPIC_API_KEY` / `claudeApiKey` / `claude_api_key`), cites PRODUCT.md §15 and REQUIREMENTS.md SEC-08, and points readers at the regression test block.

Diff slice:
```ts
+/**
+ * SEC-08 invariant — Anthropic API key must NOT live on this Config object.
+ *
+ * Do NOT add any of the following fields to ConfigSchema:
+ *   - apiKey / anthropicApiKey / anthropic_api_key
+ *   - ANTHROPIC_API_KEY (env-style name)
+ *   - claudeApiKey / claude_api_key
+ *
+ * Rationale (PRODUCT.md §15 Security + REQUIREMENTS.md SEC-08):
+ *   Anthropic authentication is handled either by (a) the Claude Code
+ *   subscription path (transparent to this codebase — no env var required),
+ *   or (b) `ANTHROPIC_API_KEY` read directly by the SDK from process.env.
+ *   In neither case should our Config deserialize or retain the key —
+ *   doing so risks (i) accidental logging via JSON.stringify(config), and
+ *   (ii) accidental persistence to .autonomous-dev/state.json or similar.
+ *
+ * Only third-party PROVIDER tokens (PostHog, GitHub, Slack) are read from
+ * env into Config, because those are used by OPTIONAL phases that need the
+ * value in-process. Anthropic auth is never in that category.
+ *
+ * Regression: tests/utils/config.test.ts SEC-08 block pins this invariant.
+ */
 export const ConfigSchema = z.object({
```

No other edits to `config.ts` — schema untouched, `loadConfig()` env reads unchanged.

### 2. `tests/utils/config.test.ts`

Added a `describe("SEC-08 Anthropic API key is never in Config", ...)` block with four cases. Also lifted `ConfigSchema` / `loadConfig` / `randomUUID` into top-level static imports (the existing block uses dynamic `await import()` inside each `it`; keeping that for the existing block, adding statics for the SEC-08 block).

- **Case 1 — Schema shape sentinel.** `EXPECTED_CONFIG_KEYS` literal array lists all 24 current top-level keys (sorted). Asserts `Object.keys(ConfigSchema.shape).sort()` equals it. Any future PR that adds a Config field must update this array, making the audit moment explicit.
- **Case 2 — No Anthropic key field.** Asserts `ConfigSchema.shape` does not contain `apiKey`, `anthropicApiKey`, `anthropic_api_key`, `ANTHROPIC_API_KEY`, `claudeApiKey`, or `claude_api_key`.
- **Case 3 — Env leak sentinel (the direct proof of SEC-08).** Sets `process.env.ANTHROPIC_API_KEY = "sk-ant-SENTINEL-<UUID>"`, calls `loadConfig()`, asserts `JSON.stringify(cfg)` contains neither the sentinel nor any `sk-ant-` substring. Restores `process.env` in `finally`.
- **Case 4 — Third-party tokens propagate; Anthropic does not.** Sets all four env vars to sentinels, asserts `cfg.posthogApiKey` / `cfg.githubToken` / `cfg.slackWebhookUrl` equal their sentinels AND `JSON.stringify(cfg)` does not contain the Anthropic sentinel.

## Verification

### Audit grep evidence

```text
$ grep -in "apikey\|ANTHROPIC_API_KEY" src/utils/config.ts
149: *   - apiKey / anthropicApiKey / anthropic_api_key
150: *   - ANTHROPIC_API_KEY (env-style name)
151: *   - claudeApiKey / claude_api_key
156: *   or (b) `ANTHROPIC_API_KEY` read directly by the SDK from process.env.
174:  posthogApiKey: z.string().optional(),
288:    posthogApiKey: process.env['POSTHOG_API_KEY'],
```
All 6 lines are either (a) the new SEC-08 comment body (lines 149–156) or (b) the legitimate `posthogApiKey` third-party-token field (lines 174, 288). **Zero field declarations for Anthropic-style keys.**

```text
$ grep -rn "apiKey" src/ --include="*.ts" | grep -v posthogApiKey | grep -v node_modules
src/utils/config.ts:149: *   - apiKey / anthropicApiKey / anthropic_api_key
```
Only match anywhere in `src/` is the SEC-08 comment itself.

```text
$ grep -E "(apiKey|anthropicApiKey|claudeApiKey|ANTHROPIC_API_KEY):" src/utils/config.ts
(no field declarations)
```
Zero field-declaration-context matches — confirms no schema field for any Anthropic-key variant.

### Checks

- `npm run typecheck`: exits 0 (clean).
- `npm test -- --run tests/utils/config.test.ts`: 13 passed (9 pre-existing + 4 new SEC-08 cases).
- `npm test`: **811 / 811 passed across 79 files**, 0 failures.
- `npm run lint`: eslint clean on `src/`.

## Commits

| Task | Message                                                                | Hash    |
|------|------------------------------------------------------------------------|---------|
| 1    | docs(02-08): add SEC-08 invariant comment above ConfigSchema          | 7320923 |
| 2    | test(02-08): add SEC-08 regression tests for Anthropic key in Config  | fe0ae31 |

## Deviations from Plan

**None — plan executed exactly as written.**

No auto-fix, no auth gate, no architectural decision. Plan notes 8 explicitly flagged that a secret-redaction helper would be scope creep and it was avoided. Plan note 7 flagged `Object.keys(ConfigSchema.shape)` returning `string[]` under strict TS — the sorted-comparison pattern from the plan was followed verbatim and typecheck passed on first attempt.

## Threat Register Disposition

From the plan's `<threat_model>`, all three STRIDE entries are now mitigated in code:

| Threat ID   | Category              | Mitigation realized                                                                                                        |
|-------------|-----------------------|----------------------------------------------------------------------------------------------------------------------------|
| T-02-08-01  | Info Disclosure       | Case 3 (env-leak sentinel) fails if `ANTHROPIC_API_KEY` propagates into JSON.stringify(cfg).                              |
| T-02-08-02  | Info Disclosure       | Case 1 (schema-shape sentinel) fails with visible diff on any new Config field; SEC-08 comment flags the invariant at review. |
| T-02-08-03  | Info Disclosure       | Case 4 confirms loadConfig ONLY reads POSTHOG/GITHUB/SLACK and NOT Anthropic.                                             |

## Self-Check: PASSED

- File `src/utils/config.ts` — FOUND (modified with SEC-08 comment; `grep -c "SEC-08 invariant"` = 1).
- File `tests/utils/config.test.ts` — FOUND (modified with new describe block; `grep -c "SEC-08 Anthropic API key is never in Config"` = 1).
- Commit `7320923` (Task 1) — FOUND in `git log --oneline`.
- Commit `fe0ae31` (Task 2) — FOUND in `git log --oneline`.
- `npm run typecheck` — PASS.
- `npm test` — 811/811 PASS.
- `npm run lint` — PASS.
