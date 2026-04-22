## Conflict Detection Report

### BLOCKERS (0)

No blockers detected. No locked-vs-locked ADR contradictions, no cross-reference cycles, no UNKNOWN-confidence-low classifications.

### WARNINGS (0)

No competing acceptance-criteria variants. The ingest contains no PRDs, so the "same requirement, divergent acceptance" check has nothing to flag.

### INFO (5)

[INFO] Auto-resolved: SPEC > DOC on default model name
  Note: README.md (precedence 3) shows config example with "model": "claude-opus-4-6"; PRODUCT.md (precedence 0) §13 specifies "model": "claude-opus-4-7" as the canonical default. PRODUCT.md wins per default precedence rules; downstream intel records the canonical value. README.md should be reconciled in a follow-up docs pass.
  source: /Users/admin/Desktop/AI/Web2/autonomous-dev-system/README.md (lines 88-92), /Users/admin/Desktop/AI/Web2/autonomous-dev-system/PRODUCT.md (§13, lines 459-484)

[INFO] Auto-resolved: SPEC > DOC on quick-mode skip set
  Note: README.md describes --quick as "Skip optional phases (env-setup, review, ab-testing)" (3 phases). PRODUCT.md §3 and §13 specify OPTIONAL_PHASES = ["environment-setup", "review", "ab-testing", "monitoring"] (4 phases). PRODUCT.md wins; the canonical skip set in requirements.md and decisions.md uses all 4. README.md is missing "monitoring" and should be updated.
  source: /Users/admin/Desktop/AI/Web2/autonomous-dev-system/README.md (line 56, line 212), /Users/admin/Desktop/AI/Web2/autonomous-dev-system/PRODUCT.md (§3 line 85, §13 line 439)

[INFO] Auto-resolved: SPEC > DOC on test count
  Note: README.md cites both "193 tests across 29 files" (line 202) and "778 tests" (line 246) — internally inconsistent. PRODUCT.md mixes "777 tests" (header line 7) and "778 тестов, 79 test-файлов" (§14 line 518, §16 line 596). The synthesized intel uses PRODUCT.md's §14/§16 figure of 777-778 tests / 79 files as the canonical recent count. README.md's "193 tests across 29 files" is stale and should be removed.
  source: /Users/admin/Desktop/AI/Web2/autonomous-dev-system/README.md (line 202, line 246), /Users/admin/Desktop/AI/Web2/autonomous-dev-system/PRODUCT.md (line 7, line 518, line 596)

[INFO] Auto-resolved: SPEC > DOC on configuration surface
  Note: README.md config example includes a "deployTarget" block (lines 105-108) with a "vercel" provider. PRODUCT.md §13 config block (lines 459-484) does not list "deployTarget" as a recognized config field, and §16 explicitly notes that "Deployment cloud provider integration" is a known product gap (staging/production phases exist but cloud deploy is partial). PRODUCT.md wins; "deployTarget" is treated as aspirational / partially-implemented, not a contractual config key. Documented in context.md status section.
  source: /Users/admin/Desktop/AI/Web2/autonomous-dev-system/README.md (lines 105-108), /Users/admin/Desktop/AI/Web2/autonomous-dev-system/PRODUCT.md (§13 lines 459-484, §16 line 623)

[INFO] Auto-resolved: SPEC > DOC on architecture file inventory
  Note: README.md lists src/state/memory-types.ts and a slimmer src/types/ directory (only llm-schemas.ts shown). PRODUCT.md §14 enumerates the full src/types/ set (llm-schemas, phases incl. OPTIONAL_PHASES, skills, task-receipt, failure-codes) and src/state/ contents. PRODUCT.md wins; constraints.md and context.md cite the PRODUCT.md inventory as the canonical layout. README.md's tree is a simplified onboarding view and the discrepancy is informational only.
  source: /Users/admin/Desktop/AI/Web2/autonomous-dev-system/README.md (lines 124-203), /Users/admin/Desktop/AI/Web2/autonomous-dev-system/PRODUCT.md (§14 lines 496-541)
