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

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed";
