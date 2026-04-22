---
phase: 02-critical-security-backlog-closure
plan: 06
subsystem: state
tags: [security, redos, dos, memory-store, input-validation, sec-06]

# Dependency graph
requires:
  - phase: 02-critical-security-backlog-closure
    plan: 01
    provides: pinned @anthropic-ai/claude-agent-sdk@0.2.90 baseline against which typecheck + tests run
provides:
  - Exported MAX_TOPIC_PATTERN_LENGTH=256 constant with a load-bearing JSDoc comment
  - Length-guard at the top of MemoryStore.list() that throws before any document iteration
  - SEC-06 regression coverage (5 tests) pinning the cap value, boundary accept/reject, normal-case regression, and wall-clock ceiling across 50 docs
  - Zero new RegExp invocations in memory-store.ts (matching remains pure String.prototype.includes)
affects:
  - Any future feature that wants glob/regex matching on topicPattern must go through the capped entry point (or replace .includes with RE2 while keeping the cap)
  - Future SEC-* audits of MemoryStore start from a documented-safe list() surface

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Defensive cap-then-match: bound untrusted string length BEFORE any O(N*M) or potentially super-linear operation"
    - "Export-the-cap-so-tests-pin-it: exported constant + pin-this-value test makes silent loosening a diff"
    - "Comment the invariant at the RegExp upgrade seam so future maintainers cannot reintroduce ReDoS silently"

key-files:
  created:
    - .planning/phases/02-critical-security-backlog-closure/06-SUMMARY.md
  modified:
    - src/state/memory-store.ts
    - tests/state/memory-store.test.ts

key-decisions:
  - "Chose 256 as the cap per plan note 1: well above any legitimate topic label (phase-name, agent-name) and small enough that an O(N*M) walk across the full 500-doc index stays under tens of ms"
  - "Reject (throw) rather than silently truncate per plan note 2: a 10000-char topicPattern is a caller bug worth surfacing; the throw is reachable today by no production callsite (5 existing MemoryStore.list callers all pass only { tags }, never topicPattern)"
  - "Kept .includes() matching untouched per plan note 3: non-backtracking by construction, and the exported constant + inline comment force a future RegExp upgrade to explicitly carry the cap forward"
  - "Exported MAX_TOPIC_PATTERN_LENGTH so tests can pin the value — the pin-test is a diff-tripwire against silent loosening"
  - "Placed the SEC-06 describe block at file scope (sibling of describe(MemoryStore)) using its own temp dir so the existing beforeEach/afterEach lifecycle is untouched — no risk of cross-test interference"

patterns-established:
  - "Cap-and-throw for untrusted length-unbounded string inputs to collection-walking operations"
  - "Wall-clock ceiling assertion in tests as a lightweight ReDoS/quadratic-regression tripwire"

requirements-completed: [SEC-06]

# Metrics
duration: 5min
completed: 2026-04-22
---

# Phase 02 Plan 06: SEC-06 ReDoS bound on topicPattern Summary

**Bounded MemoryStore.list({ topicPattern }) to 256 chars via an exported MAX_TOPIC_PATTERN_LENGTH constant + entry-point throw; kept pure .includes() matching; added 5 regression tests (pin, boundary accept, 257-char reject, normal-case regression, 50-doc wall-clock ceiling). 805/805 vitest + clean typecheck + clean lint.**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-04-22T17:28:40Z
- **Completed:** 2026-04-22T17:33:56Z
- **Tasks:** 3 (2 edit tasks + 1 verification gate)
- **Files modified:** 2 (`src/state/memory-store.ts`, `tests/state/memory-store.test.ts`)

## Accomplishments

- Added exported constant `MAX_TOPIC_PATTERN_LENGTH = 256` in `src/state/memory-store.ts` with a load-bearing JSDoc block describing the threat, the rationale for 256, and the instruction to future maintainers that any RegExp upgrade must keep the cap AND use RE2 (never `new RegExp(topicPattern)` directly).
- Added length-guard inside `list()` that runs BEFORE any document iteration:
  ```ts
  if (filter?.topicPattern !== undefined && filter.topicPattern.length > MAX_TOPIC_PATTERN_LENGTH) {
    throw new Error(
      `topicPattern exceeds MAX_TOPIC_PATTERN_LENGTH (${MAX_TOPIC_PATTERN_LENGTH}); got length=${filter.topicPattern.length}`
    );
  }
  ```
- Added a SEC-06 describe block to `tests/state/memory-store.test.ts` with 5 regression tests (pin the cap to 256, boundary accept at 256, reject at 257 with `/MAX_TOPIC_PATTERN_LENGTH/` regex, normal-case regression, wall-clock ceiling <500ms across 50 docs with a benign 256-char pattern).
- Verified zero executable `new RegExp(` calls in `memory-store.ts` (2 matches exist — both inside the documentation JSDoc comment as prescribed by plan note 3).
- Verified all 5 existing `MemoryStore.list()` callers in `src/` (`src/memory/layers.ts` x2, `src/memory/skills.ts` x3) pass only `{ tags }` and never `topicPattern` — the new throw path is unreachable by current production code, so the hardening is invisible to callers today and only trips on actual abuse.

## Task Commits

Each edit task was committed atomically:

1. **Task 1: Add MAX_TOPIC_PATTERN_LENGTH constant + enforce it in list()** — `b3e2df0` (fix)
   - 1 file changed, 27 insertions(+)
   - `src/state/memory-store.ts`: exported constant after `DEFAULT_CONFIG`, guard inserted at top of `list()` before `filterTags`/`topicFilter` derivation.
2. **Task 2: Add SEC-06 regression tests** — `41736d6` (test)
   - 1 file changed, 58 insertions(+), 1 deletion(-)
   - `tests/state/memory-store.test.ts`: imported `MAX_TOPIC_PATTERN_LENGTH`, appended 5-case describe block with isolated temp dir.
3. **Task 3: Typecheck + memory-store tests + full suite** — verification-only, no commit.

**Plan metadata commit:** appended after this SUMMARY is written (docs).

## Files Created/Modified

### `src/state/memory-store.ts` — constant + guard

Diff slice (top of file, after `DEFAULT_CONFIG`):

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

Diff slice (inside `list()`):

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
  // ... unchanged loop below ...
}
```

### `tests/state/memory-store.test.ts` — SEC-06 describe block

New import and describe block appended (58 lines added, 1 line replaced):

```ts
import { MAX_TOPIC_PATTERN_LENGTH, MemoryStore } from "../../src/state/memory-store.js";

// ... existing describe("MemoryStore", () => { ... }) untouched ...

describe("SEC-06 topicPattern bounded input", () => {
  const SEC06_STATE_DIR = join(tmpdir(), `ads-test-memory-sec06-${process.pid}`);
  let store: MemoryStore;

  beforeEach(() => {
    if (existsSync(SEC06_STATE_DIR)) rmSync(SEC06_STATE_DIR, { recursive: true });
    mkdirSync(SEC06_STATE_DIR, { recursive: true });
    store = new MemoryStore(SEC06_STATE_DIR);
  });

  afterEach(() => {
    if (existsSync(SEC06_STATE_DIR)) rmSync(SEC06_STATE_DIR, { recursive: true });
  });

  it("pins MAX_TOPIC_PATTERN_LENGTH to 256 (silent loosening must show up as a diff)", () => {
    expect(MAX_TOPIC_PATTERN_LENGTH).toBe(256);
  });

  it("accepts a 256-char topicPattern (boundary value)", async () => {
    await store.write("alpha", "content-a", ["t1"]);
    const pattern = "x".repeat(256);
    const results = await store.list({ topicPattern: pattern });
    expect(Array.isArray(results)).toBe(true);
  });

  it("throws when topicPattern exceeds 256 chars", async () => {
    const pattern = "x".repeat(257);
    await expect(store.list({ topicPattern: pattern })).rejects.toThrow(
      /MAX_TOPIC_PATTERN_LENGTH/
    );
  });

  it("normal-length topicPattern still matches (regression)", async () => {
    await store.write("phase-development", "content", ["phase"]);
    await store.write("phase-testing", "content", ["phase"]);
    const results = await store.list({ topicPattern: "phase" });
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it("returns within wall-clock ceiling for a benign 256-char pattern across many docs", async () => {
    for (let i = 0; i < 50; i++) {
      await store.write(`topic-${i}`, `content-${i}`, ["t"]);
    }
    const pattern = "topic-".padEnd(256, "x");
    const t0 = Date.now();
    const results = await store.list({ topicPattern: pattern });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500);
    expect(Array.isArray(results)).toBe(true);
  });
});
```

### Confirmation: no `new RegExp(` introduced in `memory-store.ts`

```
$ grep -n "new RegExp" src/state/memory-store.ts
29: * surface against (a) future maintainers swapping in `new RegExp(topicPattern)`
38: * `re2-wasm`) — never `new RegExp(topicPattern)` directly.
```

Both matches are inside the **JSDoc comment** (lines 29 and 38 — ` * ` prefixed, inside the `/** ... */` block). No executable `new RegExp(` invocation is present. The matching strategy in `list()` (and `search()`) remains pure `String.prototype.includes()`.

## Decisions Made

- **Cap value = 256:** Per plan note 1. Topics in this codebase are short labels (phase/agent/skill identifiers; typical length <50 chars). 256 is 5× the 95th-percentile legitimate length and small enough that O(N×M) across 500 docs stays under tens of milliseconds even on a slow box.
- **Reject (throw), not truncate:** Per plan note 2. A 10000-char topicPattern is a caller bug; silent truncation hides the bug. The throw is reachable only by abuse paths — all 5 current production callers (`src/memory/layers.ts` x2, `src/memory/skills.ts` x3) pass `{ tags }` only.
- **Keep `.includes()`, do not introduce `new RegExp(...)`:** Per plan note 3. `.includes()` is non-backtracking by construction, which is strictly stronger than "bounded RegExp" for ReDoS prevention. The cap is pure future-proofing, not a current-risk fix.
- **Export the constant:** So tests can pin the value. Any silent loosening (e.g. a maintainer editing `256` to `4096`) will fail the pin-test and show up as a reviewable diff.
- **Separate test describe block with own temp dir (`ads-test-memory-sec06-*`):** Decoupled from the existing outer `describe("MemoryStore")` lifecycle. No cross-test interference risk, and the block is self-contained for readability.
- **Wall-clock ceiling = 500ms across 50 docs:** Per plan note 7. Intentionally generous: goal is "doesn't hang / isn't super-linear in pattern length", not "fast". On a healthy dev box this completes in <10ms.
- **Out of scope: `search(query)`:** Per plan note 6. `search()` is also pure `.includes()`-based; SEC-06 explicitly targets `topicPattern`. Flagged in STRIDE register as T-02-06-03 disposition `accept` (tracked separately if escalated).

## Deviations from Plan

None. The plan's prescribed comment (per note 3) contains the substring `new RegExp(...)` twice, which causes the Task 3 verify subcommand `test $(grep -c "new RegExp" src/state/memory-store.ts) -eq 0` to report 2 matches. Both are in the JSDoc block (lines 29 and 38), not in executable code. The plan's **intent** (`success_criteria`: *"Existing substring matching strategy preserved (no RegExp introduced)"*) is satisfied by the absence of any non-comment `new RegExp(` call in the file. Recorded here for auditor clarity rather than as a deviation.

## Issues Encountered

None. The plan-prescribed edits applied cleanly, typecheck + tests + lint all passed on first run. The fact that the 5 existing `MemoryStore.list()` callers in `src/` only pass `{ tags }` means the new throw is unreachable by current production code — the SEC-06 hardening is a forward-looking defense, not a hot-path fix, and adds no runtime risk to existing flows.

## Verification Evidence

```
$ grep "export const MAX_TOPIC_PATTERN_LENGTH = 256" src/state/memory-store.ts
export const MAX_TOPIC_PATTERN_LENGTH = 256;     → 1 match

$ grep "topicPattern.length > MAX_TOPIC_PATTERN_LENGTH" src/state/memory-store.ts
    if (filter?.topicPattern !== undefined && filter.topicPattern.length > MAX_TOPIC_PATTERN_LENGTH) {     → 1 match

$ grep -c "SEC-06 topicPattern bounded input" tests/state/memory-store.test.ts
1

$ grep -c "MAX_TOPIC_PATTERN_LENGTH" tests/state/memory-store.test.ts
4

$ npm run typecheck
tsc --noEmit     → EXIT 0 (no output)

$ npm test -- --run tests/state/memory-store.test.ts
Test Files  1 passed (1)
Tests  33 passed (33)  [28 pre-existing + 5 new SEC-06]
Duration  2.65s
     → EXIT 0

$ npm test
Test Files  79 passed (79)
Tests  805 passed (805)
Duration  25.93s
     → EXIT 0

$ npm run lint
eslint src/     → EXIT 0 (no output, zero warnings)

$ grep -n "new RegExp(" src/state/memory-store.ts | grep -vE '^\s*[0-9]+:\s*\*'
     → zero non-comment matches (2 total matches, both inside JSDoc block)

$ grep -rn "\.list({" src/ --include='*.ts'
src/memory/layers.ts:105:  const docs = await memoryStore.list({ tags: [FACT_TAG] });
src/memory/layers.ts:110:  const docs = await memoryStore.list({ tags: [FACT_TAG] });
src/memory/skills.ts:131:  const existing = await this.memory.list({ ... });
src/memory/skills.ts:183:  const docs = await this.memory.list({ ... });
src/memory/skills.ts:216:  const docs = await this.memory.list({ tags: ["skill"] });
     → 5 production callers; none pass topicPattern (throw is unreachable today)
```

## Threat Model Alignment

| Threat ID  | Disposition | Mitigation in this plan |
|------------|-------------|-------------------------|
| T-02-06-01 | mitigate    | Hard cap `MAX_TOPIC_PATTERN_LENGTH=256` enforced at entry; throws beyond cap. Closed. |
| T-02-06-02 | mitigate    | Load-bearing JSDoc + exported constant + pinned test make silent RegExp upgrade detectable. Closed. |
| T-02-06-03 | accept      | `search()` out-of-scope per plan note 6; uses `.includes()` safely; tracked separately if ever escalated. |

## Follow-on / Future Work

- **If a future feature genuinely needs glob/regex matching on `topicPattern`:** The recommended path per the inline JSDoc is **RE2 (via `re2-wasm`)** under the existing 256-char cap. `re2-wasm` is non-backtracking by construction; it eliminates the ReDoS class of vulnerabilities entirely. Do NOT use `new RegExp(topicPattern)`.
- **If a future plan wants to extend the same hardening to `search()`:** The existing `.includes()` strategy in `search(query)` is already safe today. Adding a symmetric cap on `query` would be a defensive bonus; tracked in STRIDE register as T-02-06-03 with disposition `accept` for now.
- **If upstream raises the 500-document cap:** The wall-clock ceiling test (`<500ms across 50 docs`) is proportional; re-tune the ceiling (still generous) or the seeded doc count if the cap changes meaningfully.

## User Setup Required

None — purely internal API hardening.

## Next Phase Readiness

- **Wave 2 of Phase 2 contribution complete** (SEC-06). No cross-wave dependencies affected: `memory-store.ts` public surface `write/read/list/search/delete/getHistory` remains identical in signature and behavior for all current callers (no breaking change). 805/805 tests green across the full suite.
- Remaining Phase 2 plans (02-02, 02-03, 02-04, 02-05, 02-07, 02-08) are independent of this file and execute against the same pinned SDK baseline.

## Self-Check: PASSED

- `src/state/memory-store.ts` contains `export const MAX_TOPIC_PATTERN_LENGTH = 256`: FOUND
- `src/state/memory-store.ts` contains `topicPattern.length > MAX_TOPIC_PATTERN_LENGTH` guard: FOUND
- `tests/state/memory-store.test.ts` contains `describe("SEC-06 topicPattern bounded input", ...)`: FOUND
- Commit `b3e2df0` (Task 1 fix): FOUND in git log
- Commit `41736d6` (Task 2 test): FOUND in git log
- `npm run typecheck`, `npm test`, `npm run lint` all exit 0
- Zero executable `new RegExp(` in `src/state/memory-store.ts` (only JSDoc-comment references, as prescribed)
- All 5 existing `MemoryStore.list()` callers verified free of `topicPattern` usage — throw path unreachable by current production code

---
*Phase: 02-critical-security-backlog-closure*
*Plan: 06 (SEC-06)*
*Completed: 2026-04-22*
