# Phase 2: Critical Security Backlog Closure - Context

**Gathered:** 2026-04-22
**Status:** Ready for planning
**Mode:** Auto-generated (discuss skipped via workflow.skip_discuss)

<domain>
## Phase Boundary

Mitigate the 8 SEC-* items from PRODUCT.md §16 (Known gaps / Critical). Each SEC item is a concrete, bounded code change with a specific file and acceptance criterion in REQUIREMENTS.md §v1 Requirements → Security.

</domain>

<decisions>
## Implementation Decisions

All 8 items are LOCKED from PRODUCT.md and REQUIREMENTS.md. Each item names exactly one target area of code and one acceptance criterion. The planner has no scope discretion on WHAT — only on HOW to structure tasks/waves:

- SEC-01: downgrade @anthropic-ai/claude-agent-sdk to 0.2.90 (or a GHSA-fixed pin), update package.json + package-lock.json, verify npm audit clean
- SEC-02: apply wrapUserInput(tag, content) to every interpolated variable in src/self-improve/mutation-engine.ts
- SEC-03: gate LSP install commands in src/environment/lsp-manager.ts by an executable allowlist (split on whitespace + check executable name)
- SEC-04: sandbox executable allowlist in src/self-improve/sandbox.ts — forbidden binaries cannot be invoked
- SEC-05: extend src/hooks/security.ts deny-list to Glob, Grep, Agent, WebFetch tools
- SEC-06: bound ReDoS risk on topicPattern regex in src/state/memory-store.ts (length cap + non-backtracking)
- SEC-07: path-traversal hardening for every write site under .autonomous-dev/ (not only stateDir)
- SEC-08: Anthropic API key only in process.env; no Config field, no logged/serialized location

### Claude's Discretion

- Task decomposition and wave assignment (SEC-01 is the only one with a package.json change — run first; SEC-02..SEC-08 are independent file-scoped edits and can run in parallel)
- Whether a utility helper (e.g., safe-path joiner for SEC-07) should be extracted vs inlined
- Test strategy per item (preferred: regression test in tests/ mirror or existing test file; no new test files if an analogous one already covers the area)

</decisions>

<code_context>
## Existing Code Insights

Use .claude/skills/typescript/SKILL.md conventions: ESM .js imports, Zod safeParse, no execFileSync, wrapUserInput for prompts. Security hook already exists at src/hooks/security.ts — SEC-05 extends its matcher list. wrapUserInput helper is at src/utils/shared.ts.

</code_context>

<specifics>
## Specific Ideas

See REQUIREMENTS.md §Security for the authoritative per-item acceptance criteria. Every SEC-01..SEC-08 must be referenced in a plan's `requirements` field.

</specifics>

<deferred>
## Deferred Ideas

None — all 8 items are in-scope for this phase.

</deferred>
