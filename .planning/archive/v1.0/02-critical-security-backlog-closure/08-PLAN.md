---
phase: 02-critical-security-backlog-closure
plan: 08
type: execute
wave: 2
depends_on:
  - "01"
files_modified:
  - src/utils/config.ts
  - tests/utils/config.test.ts
autonomous: true
requirements:
  - SEC-08
must_haves:
  truths:
    - "ConfigSchema has zero fields named apiKey / anthropicApiKey / ANTHROPIC_API_KEY — Anthropic auth is sourced exclusively from process.env (or the SDK's built-in Claude Code subscription auth) and never deserialized into Config"
    - "loadConfig() does not read ANTHROPIC_API_KEY into defaults (only POSTHOG_API_KEY, GITHUB_TOKEN, SLACK_WEBHOOK_URL — the existing three third-party tokens stay)"
    - "A new regression test asserts: (a) `apiKey` is not a key in the parsed Config, (b) setting process.env.ANTHROPIC_API_KEY before loadConfig does NOT make it appear anywhere in JSON.stringify(Config), (c) JSON.stringify(config) contains no ANTHROPIC_API_KEY substring"
    - "A sentinel schema-shape test enumerates all allowed top-level keys in Config — adding a new secret field in a future PR shows up as a test diff"
    - "Inline comment in config.ts documents the invariant for future maintainers"
    - "npm run typecheck and npm test stay green"
  artifacts:
    - path: "src/utils/config.ts"
      provides: "Zod-validated Config schema with explicit no-apiKey invariant"
      contains: "SEC-08"
    - path: "tests/utils/config.test.ts"
      provides: "Regression coverage for no-apiKey / no-ANTHROPIC_API_KEY in Config"
      contains: "SEC-08"
  key_links:
    - from: "src/utils/config.ts#loadConfig"
      to: "process.env"
      via: "Only third-party provider tokens read from env; Anthropic SDK auth handled by SDK itself"
      pattern: "POSTHOG_API_KEY|GITHUB_TOKEN|SLACK_WEBHOOK_URL"
    - from: "tests/utils/config.test.ts"
      to: "src/utils/config.ts#ConfigSchema"
      via: "Zod parse + Object.keys enumeration assertion"
      pattern: "ConfigSchema|loadConfig"
---

<objective>
SEC-08: Audit `src/utils/config.ts` to confirm the Anthropic API key lives ONLY in `process.env` (or is handled automatically by the Claude Code subscription auth, per PRODUCT.md §15) and is NEVER deserialized into a Config field, logged, or serialized. Add regression tests + an inline invariant comment so a future maintainer cannot silently re-introduce the field.

Current state (verified via `grep -rn "apiKey\|ANTHROPIC_API_KEY" src/utils/config.ts`): there is NO `apiKey` or `ANTHROPIC_API_KEY` field in `ConfigSchema` today. The three `process.env` reads in `loadConfig` are `POSTHOG_API_KEY`, `GITHUB_TOKEN`, `SLACK_WEBHOOK_URL` — each is a third-party provider token used by the corresponding optional phase (ab-testing, github notifications, slack notifications). None of them are the Anthropic key.

This plan therefore takes an audit + lock-in shape, not a rewrite:
1. Confirm the absence with a test that parses ConfigSchema, checks the flat key set, and asserts no `apiKey*` or `anthropic*` keys exist.
2. Confirm the runtime behavior with a test that sets `process.env.ANTHROPIC_API_KEY` to a sentinel before `loadConfig()` and asserts the sentinel does not appear anywhere in the resulting `JSON.stringify(config)`.
3. Add a SEC-08 inline comment block above ConfigSchema stating the invariant.
4. Add a sentinel schema-shape test that enumerates the set of allowed top-level Config keys as a literal array — adding a new key becomes a visible test diff.

Purpose: Close PRODUCT.md §16 / REQUIREMENTS.md SEC-08 ("Anthropic API key removed from any Config field — lives only in process.env; no logged or serialized location"). The state is already correct; this plan prevents regression.

Output: `src/utils/config.ts` with a clarifying comment header above ConfigSchema; `tests/utils/config.test.ts` with a SEC-08 describe block.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/REQUIREMENTS.md
@.planning/intel/constraints.md
@.planning/phases/02-critical-security-backlog-closure/02-CONTEXT.md
@src/utils/config.ts
@.claude/skills/typescript/SKILL.md

<interfaces>
Current ConfigSchema top-level keys (enumerated by reading src/utils/config.ts lines 145 to 206):
- model
- subagentModel
- posthogApiKey
- githubToken
- slackWebhookUrl
- deployTarget
- selfImprove
- projectDir
- stateDir
- autonomousMode
- maxTurns
- budgetUsd
- dryRun
- quickMode
- confirmSpec
- memory
- codexSubagents
- rubrics
- maxParallelBatches
- roles
- retryPolicy
- developmentCoordinator
- auxiliaryProfile
- interactive

Current loadConfig env reads (lines 265 to 269):
```ts
const defaults: Record<string, unknown> = {
  posthogApiKey: process.env['POSTHOG_API_KEY'],
  githubToken: process.env['GITHUB_TOKEN'],
  slackWebhookUrl: process.env['SLACK_WEBHOOK_URL'],
};
```

Absent (this is the invariant to lock): no `apiKey`, no `anthropicApiKey`, no `ANTHROPIC_API_KEY`, no `claudeApiKey` anywhere.

Test file to extend: `tests/utils/config.test.ts`.
</interfaces>

<notes_for_executor>
1. No schema changes to ConfigSchema — the current shape is correct.
2. Add ONLY:
   - An inline SEC-08 comment directly above `export const ConfigSchema = z.object({ ... })` documenting the invariant.
   - A test block in tests/utils/config.test.ts that assertively pins the invariant.
3. The schema-shape sentinel test takes an EXPECTED_CONFIG_KEYS local array in the test file with all 24 current top-level keys, and asserts that Object.keys(ConfigSchema.shape) equals it (sorted). Future PRs that add a key MUST update the array, which gets caught in review.
4. The JSON.stringify test: set `process.env['ANTHROPIC_API_KEY'] = 'sk-ant-SENTINEL-' + randomUUID()`, call loadConfig(), then assert JSON.stringify(loadConfig()) does NOT contain the sentinel substring. Restore the env var after.
5. Do NOT test the SDK's own behavior (whether the SDK reads ANTHROPIC_API_KEY). That is out of scope — the SDK's env consumption is its own boundary. SEC-08 is specifically about our Config object not storing the key.
6. If the existing tests/utils/config.test.ts mocks process.env in some setup, reuse that pattern. Otherwise set/restore with try/finally.
7. Strict TypeScript per `.claude/skills/typescript/SKILL.md` — `Object.keys(ConfigSchema.shape)` returns `string[]`. Sort before comparison.
8. Do NOT add a new secret-redaction helper. The project doesn't log the Config object today, and adding a redactor would be scope creep. If redaction is wanted later it's a separate plan.
</notes_for_executor>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add SEC-08 invariant comment above ConfigSchema</name>
  <files>src/utils/config.ts</files>
  <action>
Locate `export const ConfigSchema = z.object({` (line 145 today). Insert a JSDoc comment block IMMEDIATELY before that line:

```ts
/**
 * SEC-08 invariant — Anthropic API key must NOT live on this Config object.
 *
 * Do NOT add any of the following fields to ConfigSchema:
 *   - apiKey / anthropicApiKey / anthropic_api_key
 *   - ANTHROPIC_API_KEY (env-style name)
 *   - claudeApiKey / claude_api_key
 *
 * Rationale (PRODUCT.md §15 Security + REQUIREMENTS.md SEC-08):
 *   Anthropic authentication is handled either by (a) the Claude Code
 *   subscription path (transparent to this codebase — no env var required),
 *   or (b) `ANTHROPIC_API_KEY` read directly by the SDK from process.env.
 *   In neither case should our Config deserialize or retain the key —
 *   doing so risks (i) accidental logging via JSON.stringify(config), and
 *   (ii) accidental persistence to .autonomous-dev/state.json or similar.
 *
 * Only third-party PROVIDER tokens (PostHog, GitHub, Slack) are read from
 * env into Config, because those are used by OPTIONAL phases that need the
 * value in-process. Anthropic auth is never in that category.
 *
 * Regression: tests/utils/config.test.ts SEC-08 block pins this invariant.
 */
export const ConfigSchema = z.object({
```

Self-check:
- `grep -c "SEC-08 invariant" src/utils/config.ts` returns 1.
- No other changes anywhere in the file — the comment is the only edit.
- Existing env reads in loadConfig (POSTHOG_API_KEY / GITHUB_TOKEN / SLACK_WEBHOOK_URL) unchanged.
  </action>
  <verify>
    <automated>grep -c "SEC-08 invariant" src/utils/config.ts; npm run typecheck</automated>
  </verify>
  <done>
- `grep "SEC-08 invariant" src/utils/config.ts` returns 1 match.
- No schema field named `apiKey` / `anthropicApiKey` / `ANTHROPIC_API_KEY` / `claudeApiKey` exists in ConfigSchema.
- `loadConfig` env reads are still exactly POSTHOG_API_KEY / GITHUB_TOKEN / SLACK_WEBHOOK_URL — no new env read added.
- `npm run typecheck` exits 0.
  </done>
</task>

<task type="auto">
  <name>Task 2: Add SEC-08 regression tests (schema shape + env leak + sentinel)</name>
  <files>tests/utils/config.test.ts</files>
  <action>
READ tests/utils/config.test.ts once to identify existing imports and the pattern used for env-var setup/teardown. Then APPEND a new describe block at the end.

Required block (verbatim, adjust imports to dedupe):

```ts
import { ConfigSchema, loadConfig } from "../../src/utils/config.js";
import { randomUUID } from "node:crypto";

describe("SEC-08 Anthropic API key is never in Config", () => {
  const EXPECTED_CONFIG_KEYS = [
    "model",
    "subagentModel",
    "posthogApiKey",
    "githubToken",
    "slackWebhookUrl",
    "deployTarget",
    "selfImprove",
    "projectDir",
    "stateDir",
    "autonomousMode",
    "maxTurns",
    "budgetUsd",
    "dryRun",
    "quickMode",
    "confirmSpec",
    "memory",
    "codexSubagents",
    "rubrics",
    "maxParallelBatches",
    "roles",
    "retryPolicy",
    "developmentCoordinator",
    "auxiliaryProfile",
    "interactive",
  ].sort();

  it("ConfigSchema top-level keys match the expected set exactly", () => {
    const actual = Object.keys(ConfigSchema.shape).sort();
    expect(actual).toEqual(EXPECTED_CONFIG_KEYS);
  });

  it("ConfigSchema has no apiKey / anthropicApiKey / claudeApiKey field", () => {
    const keys = Object.keys(ConfigSchema.shape);
    expect(keys).not.toContain("apiKey");
    expect(keys).not.toContain("anthropicApiKey");
    expect(keys).not.toContain("anthropic_api_key");
    expect(keys).not.toContain("ANTHROPIC_API_KEY");
    expect(keys).not.toContain("claudeApiKey");
    expect(keys).not.toContain("claude_api_key");
  });

  it("loadConfig() does not leak process.env.ANTHROPIC_API_KEY into the Config object", () => {
    const sentinel = "sk-ant-SENTINEL-" + randomUUID();
    const prev = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = sentinel;
    try {
      const cfg = loadConfig();
      const serialized = JSON.stringify(cfg);
      expect(serialized).not.toContain(sentinel);
      expect(serialized).not.toContain("sk-ant-");
    } finally {
      if (prev === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = prev;
    }
  });

  it("loadConfig() ONLY reads third-party provider tokens from env (not Anthropic)", () => {
    const prevPh = process.env['POSTHOG_API_KEY'];
    const prevGh = process.env['GITHUB_TOKEN'];
    const prevSl = process.env['SLACK_WEBHOOK_URL'];
    const prevAn = process.env['ANTHROPIC_API_KEY'];
    process.env['POSTHOG_API_KEY'] = "ph-SENTINEL";
    process.env['GITHUB_TOKEN'] = "gh-SENTINEL";
    process.env['SLACK_WEBHOOK_URL'] = "https://hooks.slack.com/SENTINEL";
    process.env['ANTHROPIC_API_KEY'] = "sk-ant-should-not-propagate";
    try {
      const cfg = loadConfig();
      expect(cfg.posthogApiKey).toBe("ph-SENTINEL");
      expect(cfg.githubToken).toBe("gh-SENTINEL");
      expect(cfg.slackWebhookUrl).toBe("https://hooks.slack.com/SENTINEL");
      const serialized = JSON.stringify(cfg);
      expect(serialized).not.toContain("sk-ant-should-not-propagate");
    } finally {
      const restore = (name: string, val: string | undefined) => {
        if (val === undefined) delete process.env[name];
        else process.env[name] = val;
      };
      restore('POSTHOG_API_KEY', prevPh);
      restore('GITHUB_TOKEN', prevGh);
      restore('SLACK_WEBHOOK_URL', prevSl);
      restore('ANTHROPIC_API_KEY', prevAn);
    }
  });
});
```

Notes:
- EXPECTED_CONFIG_KEYS is the sentinel schema shape — any time a PR adds a Config field, this array must update, and that diff is the audit moment.
- If the existing test file already has an env-vars save/restore helper, reuse it instead of the inline try/finally pattern — preserve the file's style.
- The third test ("does not leak process.env.ANTHROPIC_API_KEY") is the most important and is the direct proof of SEC-08.
- Do NOT add a test that asserts the SDK rejects a missing ANTHROPIC_API_KEY. That is SDK behavior, not our invariant.
  </action>
  <verify>
    <automated>grep -c "SEC-08 Anthropic API key is never in Config" tests/utils/config.test.ts</automated>
  </verify>
  <done>
- New describe block "SEC-08 Anthropic API key is never in Config" present in tests/utils/config.test.ts.
- Block contains 4 cases: schema-shape sentinel, no-apiKey negative assertion, JSON.stringify sentinel leak test, third-party-token positive + Anthropic negative test.
- EXPECTED_CONFIG_KEYS literal array lists all 24 current top-level keys (sorted).
- Existing config tests untouched.
  </done>
</task>

<task type="auto">
  <name>Task 3: Typecheck + run config tests + full suite</name>
  <files>(no files modified — verification-only)</files>
  <action>
1. `npm run typecheck` — must exit 0.
2. `npm test -- --run tests/utils/config.test.ts` — all SEC-08 cases plus pre-existing cases must be green. If the EXPECTED_CONFIG_KEYS list does not match the actual schema (because some key was mistyped), the first test fails with a clear diff — fix the list (not the schema).
3. `npm test` — full green baseline.
4. For the SUMMARY, capture:
   - `grep -rn "apiKey\|ANTHROPIC_API_KEY" src/utils/config.ts` — expected to return the three POSTHOG/GITHUB/SLACK lines plus the new SEC-08 comment mentions, and ZERO matches that look like `apiKey:` field declarations.
   - `grep -rn "apiKey" src/ --include="*.ts" | grep -v posthogApiKey | grep -v node_modules` — record to prove there is no other `apiKey` field anywhere in src/.
  </action>
  <verify>
    <automated>npm run typecheck &amp;&amp; npm test -- --run tests/utils/config.test.ts &amp;&amp; npm test</automated>
  </verify>
  <done>
- `npm run typecheck` exits 0.
- `npm test -- --run tests/utils/config.test.ts` green.
- `npm test` full green baseline.
- SUMMARY records the grep outputs proving no apiKey field exists in src/utils/config.ts and no rogue `apiKey` field lives elsewhere in src/.
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| process.env.ANTHROPIC_API_KEY → our Config object | Must NOT cross. Config is serialized to disk (state.json) and logged (dashboard, audit) — any key placed here is a disclosure risk. |
| process.env third-party tokens (POSTHOG/GITHUB/SLACK) → Config | Crosses deliberately; these are needed in-process by optional phases. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-02-08-01 | Information Disclosure | Anthropic API key leaking to Config → state.json / logs | mitigate | No ConfigSchema field for the key; loadConfig does not read ANTHROPIC_API_KEY; regression test asserts JSON.stringify(cfg) cannot contain the sentinel. |
| T-02-08-02 | Information Disclosure | Future PR silently adding `apiKey` field to Config | mitigate | EXPECTED_CONFIG_KEYS sentinel test fails with visible diff the moment a new Config key is added; SEC-08 inline comment in config.ts flags the invariant for code review. |
| T-02-08-03 | Information Disclosure | Accidental redirect of third-party token sources to include Anthropic | mitigate | Positive-path test confirms loadConfig ONLY reads POSTHOG/GITHUB/SLACK, and a parallel negative assertion rules out ANTHROPIC_API_KEY propagation. |
</threat_model>

<verification>
End-to-end phase checks for this plan:
- `grep "SEC-08 invariant" src/utils/config.ts` returns 1 match.
- `grep -E "(apiKey|anthropicApiKey|claudeApiKey|ANTHROPIC_API_KEY):" src/utils/config.ts` returns 0 matches in field-declaration context (ignoring the SEC-08 comment body which contains the token names as a warning list).
- `tests/utils/config.test.ts` contains the SEC-08 describe block with 4 cases, all passing.
- `npm run typecheck && npm test` green.
</verification>

<success_criteria>
- ConfigSchema contains no Anthropic API key field.
- loadConfig does not read ANTHROPIC_API_KEY into Config.
- Regression tests fail visibly if a future PR adds a secret field or pipes ANTHROPIC_API_KEY through loadConfig.
- Inline comment documents the invariant for future maintainers.
</success_criteria>

<output>
After completion, create `.planning/phases/02-critical-security-backlog-closure/02-08-SUMMARY.md` including:
- Diff slice of `src/utils/config.ts` showing the new SEC-08 comment block.
- New describe block added to `tests/utils/config.test.ts`.
- `grep -rn "apiKey\|ANTHROPIC_API_KEY" src/utils/config.ts` output proving no field declarations exist.
- `grep -rn "apiKey" src/ --include="*.ts" | grep -v posthogApiKey` output proving no other `apiKey` field anywhere in src/.
</output>
