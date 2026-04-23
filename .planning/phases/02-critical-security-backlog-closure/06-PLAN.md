---
phase: 02-critical-security-backlog-closure
plan: 06
type: execute
wave: 2
depends_on:
  - "01"
files_modified:
  - src/state/memory-store.ts
  - tests/state/memory-store.test.ts
autonomous: true
requirements:
  - SEC-06
must_haves:
  truths:
    - "MemoryStore.list({ topicPattern }) caps the topicPattern input length to MAX_TOPIC_PATTERN_LENGTH (256) and rejects (or truncates with a logged warning) longer values"
    - "topicPattern matching uses a non-backtracking strategy (current implementation uses .includes() which is O(n*m) without catastrophic backtracking; the cap covers the future regression risk if anyone swaps in `new RegExp(topicPattern)`)"
    - "An exported MAX_TOPIC_PATTERN_LENGTH constant documents the bound so future maintainers see it"
    - "Regression tests cover: (a) normal short pattern matches, (b) 256-char pattern accepted, (c) 257-char pattern rejected with throw or empty result, (d) ReDoS-shaped repeating pattern (e.g. 'a' * 1000 + '!') runs in <100ms"
    - "npm run typecheck and npm test stay green"
  artifacts:
    - path: "src/state/memory-store.ts"
      provides: "Hardened MemoryStore.list with bounded topicPattern input"
      contains: "MAX_TOPIC_PATTERN_LENGTH"
    - path: "tests/state/memory-store.test.ts"
      provides: "ReDoS regression coverage + length-cap tests"
      contains: "MAX_TOPIC_PATTERN_LENGTH"
  key_links:
    - from: "src/state/memory-store.ts#list"
      to: "src/state/memory-store.ts#MAX_TOPIC_PATTERN_LENGTH"
      via: "Length check before .toLowerCase()"
      pattern: "MAX_TOPIC_PATTERN_LENGTH"
    - from: "tests/state/memory-store.test.ts"
      to: "src/state/memory-store.ts"
      via: "Vitest direct invocation of store.list({ topicPattern })"
      pattern: "topicPattern"
---

<objective>
SEC-06: Bound the ReDoS risk on the `topicPattern` input to `MemoryStore.list()` in `src/state/memory-store.ts`.

Current state of the code (see file lines 279 to 301): `topicPattern` is consumed via plain `String.prototype.includes()` after lowercasing — no `RegExp` is ever constructed. So in the **current implementation** there is no actual ReDoS surface; the worst case is O(N × M) substring matching against the index. However:

1. The REQUIREMENTS.md SEC-06 wording calls out "ReDoS pattern in `topicPattern` regex" — this reflects the threat model, not necessarily the current code shape. The explicit acceptance criterion is: "regex is bounded with input length cap and/or non-backtracking pattern".
2. The PRODUCT.md §16 backlog calls out the same concern.
3. The defensive engineering goal is to make sure a future maintainer who "improves" `list()` to use `new RegExp(topicPattern)` (a natural extension when callers want glob-like matching) cannot reintroduce the ReDoS risk silently.

This plan therefore: (a) introduces a hard length cap `MAX_TOPIC_PATTERN_LENGTH = 256` enforced at the top of `list()`, (b) keeps the existing `.includes()` matching (non-backtracking by definition), (c) documents the invariant inline so a future RegExp upgrade is forced through this cap, (d) adds regression tests pinning the cap value and exercising a synthetic ReDoS-shaped input within a wall-clock ceiling.

Purpose: Eliminate the ReDoS attack surface today (length cap blocks giant inputs) and ensure the surface cannot be reintroduced silently tomorrow (constant + tests + comment).

Output: `memory-store.ts` with `MAX_TOPIC_PATTERN_LENGTH` constant + length guard at the top of `list()`; `memory-store.test.ts` with a SEC-06 describe block.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/REQUIREMENTS.md
@.planning/intel/constraints.md
@.planning/phases/02-critical-security-backlog-closure/02-CONTEXT.md
@src/state/memory-store.ts
@.claude/skills/typescript/SKILL.md

<interfaces>
Current list() signature and topicPattern handling (src/state/memory-store.ts lines 279 to 301):
```ts
async list(filter?: { tags?: string[]; topicPattern?: string }): Promise<MemoryDocument[]> {
  const index = await this.loadIndex();
  const results: MemoryDocument[] = [];

  const filterTags = filter?.tags?.map((t) => t.toLowerCase());
  const topicFilter = filter?.topicPattern?.toLowerCase() ?? null;

  for (const [id, meta] of Object.entries(index.documents)) {
    if (meta.archived) continue;

    if (filterTags && filterTags.length > 0) {
      const docTags = meta.tags.map((t) => t.toLowerCase());
      if (!filterTags.some((ft) => docTags.includes(ft))) continue;
    }

    if (topicFilter && !meta.topic.toLowerCase().includes(topicFilter)) continue;

    const doc = await this.readDoc(id);
    if (doc && !doc.archived) results.push(doc);
  }

  return results;
}
```

Public API surface to preserve:
- `MemoryStore.list(filter?: { tags?: string[]; topicPattern?: string }): Promise<MemoryDocument[]>`
- Behavior for normal-length topicPattern: substring (case-insensitive) match against `meta.topic` — unchanged.

Existing test file: `tests/state/memory-store.test.ts` (already exercises happy-path list/search). Reuse its setup pattern.
</interfaces>

<notes_for_executor>
1. Choose 256 as the cap. Rationale: longer than any plausible legitimate topic name (topics in this codebase are typically `phase-name`, `agent-name`, `lessons-learned-XYZ` — well under 100 chars), small enough that even an O(N × M) walk over the full 500-document index stays under tens of milliseconds.
2. Reject path: throw `new Error("topicPattern exceeds MAX_TOPIC_PATTERN_LENGTH (256)")`. Throwing is preferred over silent truncation because callers that pass a 10000-char pattern have a bug worth surfacing. The error is caught nowhere in the existing path, but `list()` is only called from a small number of places (search-driven UIs do not exist yet); the throw is acceptable.
3. Keep the existing `.includes()` strategy — do NOT introduce `new RegExp(...)`. The comment on the constant must explicitly say so: "If a future maintainer changes the matching strategy to RegExp, the cap MUST stay; preferably a non-backtracking implementation (e.g. RE2 via 're2-wasm') should be used."
4. Export `MAX_TOPIC_PATTERN_LENGTH` so tests can pin it and silent loosening shows up as a diff.
5. Strict TS per `.claude/skills/typescript/SKILL.md` — `filter?.topicPattern` is `string | undefined`; the length check uses `filter.topicPattern.length` after a non-null narrow. No type churn.
6. The existing search() method (lines 226 to 277) takes a `query: string` and runs `.includes()` against content — that is OUT OF SCOPE for SEC-06 (the spec singled out `topicPattern`). Do not modify `search()`.
7. Tests must include a wall-clock ceiling assertion for the ReDoS-shaped input. Use `Date.now()` deltas (vitest accepts; we already use this pattern in sandbox tests).
</notes_for_executor>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add MAX_TOPIC_PATTERN_LENGTH constant and enforce it in list()</name>
  <files>src/state/memory-store.ts</files>
  <action>
Edit 1 — add the exported constant. Insert IMMEDIATELY after the `DEFAULT_CONFIG` declaration (currently lines 20 to 23):

After:
```ts
const DEFAULT_CONFIG: MemoryStoreConfig = {
  maxDocuments: 500,
  maxDocumentSizeKb: 100,
};

/**
 * SEC-06: Hard cap on the length of `topicPattern` accepted by `MemoryStore.list()`.
 * Today the matching strategy is plain String.prototype.includes() (non-backtracking
 * by definition), so the practical risk is bounded; this cap closes the
 * surface against (a) future maintainers swapping in `new RegExp(topicPattern)`
 * which would reintroduce ReDoS, and (b) accidental DoS from a 1MB pattern walking
 * the full 500-document index.
 *
 * Topic names in this codebase are short labels (phase/agent/skill identifiers).
 * 256 chars is well above any legitimate use.
 *
 * If a future maintainer changes the matcher to RegExp, this cap MUST remain
 * AND the implementation should use a non-backtracking engine (e.g. RE2 via
 * `re2-wasm`) — never `new RegExp(topicPattern)` directly.
 */
export const MAX_TOPIC_PATTERN_LENGTH = 256;
```

Edit 2 — enforce the cap at the top of `list()` (currently lines 279 to 301). Add the guard INSIDE `list()` immediately after the `loadIndex` call but BEFORE the `topicFilter` derivation:

Before:
```ts
  async list(filter?: { tags?: string[]; topicPattern?: string }): Promise<MemoryDocument[]> {
    const index = await this.loadIndex();
    const results: MemoryDocument[] = [];

    const filterTags = filter?.tags?.map((t) => t.toLowerCase());
    const topicFilter = filter?.topicPattern?.toLowerCase() ?? null;
```

After:
```ts
  async list(filter?: { tags?: string[]; topicPattern?: string }): Promise<MemoryDocument[]> {
    const index = await this.loadIndex();
    const results: MemoryDocument[] = [];

    // SEC-06: bound the topicPattern input length to prevent (a) DoS via giant
    // pattern walked across the full document index, and (b) future ReDoS if
    // the matching strategy is ever upgraded to RegExp. See the
    // MAX_TOPIC_PATTERN_LENGTH constant for rationale.
    if (filter?.topicPattern !== undefined && filter.topicPattern.length > MAX_TOPIC_PATTERN_LENGTH) {
      throw new Error(
        `topicPattern exceeds MAX_TOPIC_PATTERN_LENGTH (${MAX_TOPIC_PATTERN_LENGTH}); got length=${filter.topicPattern.length}`
      );
    }

    const filterTags = filter?.tags?.map((t) => t.toLowerCase());
    const topicFilter = filter?.topicPattern?.toLowerCase() ?? null;
```

Self-check after editing:
- `grep -n "MAX_TOPIC_PATTERN_LENGTH" src/state/memory-store.ts` must return at least 3 lines (export, length comparison, and error message).
- `grep -n "topicPattern" src/state/memory-store.ts` must show the new guard inside `list()` and the unchanged usage below it.
- Critical invariant: the throw happens BEFORE the for-loop, not inside it.
  </action>
  <verify>
    <automated>grep -c "export const MAX_TOPIC_PATTERN_LENGTH = 256" src/state/memory-store.ts &amp;&amp; grep -c "topicPattern.length &gt; MAX_TOPIC_PATTERN_LENGTH" src/state/memory-store.ts &amp;&amp; npm run typecheck</automated>
  </verify>
  <done>
- `grep "export const MAX_TOPIC_PATTERN_LENGTH = 256" src/state/memory-store.ts` returns one match.
- `grep "topicPattern.length > MAX_TOPIC_PATTERN_LENGTH" src/state/memory-store.ts` returns one match (the guard line).
- The guard is inside `list()` and runs before any document iteration.
- Existing list() / search() / write() / read() behavior for normal inputs is unchanged.
- `npm run typecheck` exits 0.
  </done>
</task>

<task type="auto">
  <name>Task 2: Add SEC-06 regression tests (length cap + ReDoS-shaped input wall-clock ceiling)</name>
  <files>tests/state/memory-store.test.ts</files>
  <action>
Read `tests/state/memory-store.test.ts` once to learn the existing setup pattern (test temp dir, MemoryStore instantiation). Then APPEND a new describe block at the bottom of the file:

```ts
import { MAX_TOPIC_PATTERN_LENGTH } from "../../src/state/memory-store.js";
// keep all other existing imports

describe("SEC-06 topicPattern bounded input", () => {
  it("pins MAX_TOPIC_PATTERN_LENGTH to 256 (silent loosening must show up as a diff)", () => {
    expect(MAX_TOPIC_PATTERN_LENGTH).toBe(256);
  });

  it("accepts a 256-char topicPattern (boundary value)", async () => {
    const store = await makeStore(); // reuse the file's existing helper or inline setup
    await store.write("alpha", "content-a", ["t1"]);
    const pattern = "x".repeat(256);
    const results = await store.list({ topicPattern: pattern });
    // 'x'*256 will not match topic 'alpha' — empty result is correct, the point
    // is that the call did not throw at the boundary.
    expect(Array.isArray(results)).toBe(true);
  });

  it("throws when topicPattern exceeds 256 chars", async () => {
    const store = await makeStore();
    const pattern = "x".repeat(257);
    await expect(store.list({ topicPattern: pattern })).rejects.toThrow(
      /MAX_TOPIC_PATTERN_LENGTH/
    );
  });

  it("normal-length topicPattern still matches (regression)", async () => {
    const store = await makeStore();
    await store.write("phase-development", "content", ["phase"]);
    await store.write("phase-testing", "content", ["phase"]);
    const results = await store.list({ topicPattern: "phase" });
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it("returns within wall-clock ceiling for a benign 256-char pattern across many docs", async () => {
    const store = await makeStore();
    // Seed 50 documents (well below the 500 cap) with varied topics.
    for (let i = 0; i < 50; i++) {
      await store.write(`topic-${i}`, `content-${i}`, ["t"]);
    }
    const pattern = "topic-".padEnd(256, "x"); // benign, won't match anything but exercises the walk
    const t0 = Date.now();
    const results = await store.list({ topicPattern: pattern });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500); // generous; on a healthy box this is <50ms
    expect(Array.isArray(results)).toBe(true);
  });
});
```

Notes for the executor:
- If the test file does not already define a `makeStore()` helper, inline `MemoryStore` instantiation against a `mkdtempSync` directory the same way other tests in the file do (read the file once to see the pattern; do not invent a new pattern).
- If the existing tests already use `beforeEach`/`afterEach` for cleanup, reuse that scaffold.
- The 500ms ceiling is intentionally generous to avoid CI flakiness; the goal is "doesn't hang", not "fast".
- Do not add any `new RegExp(pattern)` usage in the production code. The implementation must remain `String.prototype.includes()`.
  </action>
  <verify>
    <automated>grep -c "SEC-06 topicPattern bounded input" tests/state/memory-store.test.ts &amp;&amp; grep -c "MAX_TOPIC_PATTERN_LENGTH" tests/state/memory-store.test.ts</automated>
  </verify>
  <done>
- New describe block `SEC-06 topicPattern bounded input` present in `tests/state/memory-store.test.ts`.
- Block contains: pin-the-cap test, 256-char boundary accept, 257-char reject (throws), normal-pattern regression, wall-clock ceiling test.
- `MAX_TOPIC_PATTERN_LENGTH` imported from `memory-store.js`.
- Existing memory-store tests untouched.
  </done>
</task>

<task type="auto">
  <name>Task 3: Typecheck + run memory-store tests + full suite</name>
  <files>(no files modified — verification-only)</files>
  <action>
1. `npm run typecheck` — must exit 0.
2. `npm test -- --run tests/state/memory-store.test.ts` — all SEC-06 cases plus pre-existing cases must be green.
3. `npm test` — full suite green.
4. `grep -rn "topicPattern\|MAX_TOPIC_PATTERN_LENGTH" src/ tests/ --include="*.ts"` — full callsite list for the SUMMARY.
5. Sanity check that no `new RegExp(` was added: `grep -n "new RegExp" src/state/memory-store.ts` must return 0 lines (the file should remain pure substring matching).
  </action>
  <verify>
    <automated>npm run typecheck &amp;&amp; npm test -- --run tests/state/memory-store.test.ts &amp;&amp; npm test &amp;&amp; test $(grep -c "new RegExp" src/state/memory-store.ts) -eq 0</automated>
  </verify>
  <done>
- `npm run typecheck` exits 0.
- `npm test -- --run tests/state/memory-store.test.ts` green.
- `npm test` full green baseline.
- Zero `new RegExp(` calls in `memory-store.ts` (matching strategy stays substring-based).
- SUMMARY captures the full callsite grep + the rationale for sticking with `.includes()`.
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Caller-supplied `topicPattern` → MemoryStore.list() | Pattern is currently substring-matched (safe today). Boundary documented + capped to prevent future regression. |
| Future maintainer's RegExp upgrade → `new RegExp(topicPattern)` | Without the cap + comment, a quick PR could reintroduce ReDoS. The cap survives that transition. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-02-06-01 | Denial of Service | MemoryStore.list with giant topicPattern | mitigate | Hard cap MAX_TOPIC_PATTERN_LENGTH=256 enforced at function entry; throws beyond cap. |
| T-02-06-02 | Denial of Service | Future ReDoS if RegExp matching is introduced | mitigate | Inline comment + exported constant make the invariant load-bearing; tests pin the cap value. |
| T-02-06-03 | Denial of Service | search() method | accept | Out of scope for SEC-06; uses `.includes()` over `query`, similarly safe; tracked separately if ever escalated. |
</threat_model>

<verification>
End-to-end phase checks for this plan:
- `grep "export const MAX_TOPIC_PATTERN_LENGTH" src/state/memory-store.ts` returns one match.
- `grep "topicPattern.length > MAX_TOPIC_PATTERN_LENGTH" src/state/memory-store.ts` returns one match.
- Zero `new RegExp(` in `memory-store.ts`.
- `tests/state/memory-store.test.ts` contains the SEC-06 describe block, all cases passing.
- `npm run typecheck && npm test` green.
</verification>

<success_criteria>
- topicPattern input is bounded to 256 characters; longer inputs throw.
- Existing substring matching strategy preserved (no RegExp introduced).
- Cap value is test-pinned so silent loosening is detectable.
- ReDoS surface eliminated today and protected against future regression.
</success_criteria>

<output>
After completion, create `.planning/phases/02-critical-security-backlog-closure/02-06-SUMMARY.md` including:
- Diff slice of `memory-store.ts` showing the constant + guard.
- New describe block added to `memory-store.test.ts`.
- Confirmation that no `new RegExp(` exists in the file.
- Note: if a future feature genuinely needs glob/regex matching on topicPattern, the recommended approach is RE2 (re2-wasm) under the existing 256-char cap.
</output>
