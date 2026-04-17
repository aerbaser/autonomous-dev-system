export type Phase =
  | "ideation"
  | "specification"
  | "architecture"
  | "environment-setup"
  | "development"
  | "testing"
  | "review"
  | "staging"
  | "ab-testing"
  | "analysis"
  | "production"
  | "monitoring";

export const ALL_PHASES = [
  "ideation", "specification", "architecture", "environment-setup",
  "development", "testing", "review", "staging",
  "ab-testing", "analysis", "production", "monitoring",
] as const satisfies readonly Phase[];

/**
 * Phases skipped when --quick is set. PRODUCT.md §3 documents these as optional:
 * environment-setup, review, ab-testing, monitoring. Single source of truth —
 * imported by orchestrator (skip logic) and the CLI (dry-run plan printout).
 * Typed as `readonly Phase[]` (not a narrow tuple) so `.includes(phase)` accepts
 * any `Phase` without requiring the caller to prove membership first.
 */
export const OPTIONAL_PHASES: readonly Phase[] = [
  "environment-setup",
  "review",
  "ab-testing",
  "monitoring",
];

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed";
