import type { ProjectState } from "../../state/project-state.js";
import type { PhaseContract, PhaseContext } from "../phase-contract.js";
import { ReviewResultSchema } from "../../types/llm-schemas.js";
import type { z } from "zod";

type ReviewResultParsed = z.infer<typeof ReviewResultSchema>;

function reviewContextSelector(state: ProjectState): PhaseContext {
  const summary: string[] = [];
  const slices: Record<string, unknown> = {};

  summary.push(`Idea: ${state.idea}`);
  if (state.spec) {
    summary.push(`User stories: ${state.spec.userStories.length}`);
    summary.push(`NFRs: ${state.spec.nonFunctionalRequirements.length}`);
  }
  if (state.architecture) {
    summary.push(`Components: ${state.architecture.components.length}`);
    summary.push(
      `Tech: ${Object.entries(state.architecture.techStack)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}`,
    );
  }
  if (state.tasks.length > 0) {
    const done = state.tasks.filter((t) => t.status === "completed").length;
    summary.push(`Tasks: ${done}/${state.tasks.length} complete`);
  }

  // Slices intentionally small — the review reads code directly via Read tool,
  // not via the state JSON. Only pass invariants: architecture summary + any
  // prior-attempt review history.
  if (state.architecture) {
    slices["architecture"] = {
      techStack: state.architecture.techStack,
      components: state.architecture.components,
    };
  }
  const reviewHistory = state.phaseAttempts?.["review"] ?? [];
  if (reviewHistory.length > 0) {
    slices["priorReviewAttempts"] = reviewHistory.slice(-3);
  }

  return { summary, slices };
}

/**
 * v1.1 super-lead contract for the review phase.
 *
 * Lead delegates to security-auditor + accessibility-auditor, integrates
 * their findings, and returns a final verdict. If critical findings remain
 * the lead sets nextPhase="development" (legal per VALID_TRANSITIONS).
 */
export const reviewContract: PhaseContract<ReviewResultParsed> = {
  phase: "review",
  goals: [
    "Conduct a multi-perspective code review of the implemented project.",
    "",
    "Responsibilities:",
    "- Use the Read, Grep, Glob tools to traverse the actual source code — do NOT review the spec.",
    "- Invoke the security-auditor for OWASP/injection/auth/secrets review.",
    "- Invoke the accessibility-auditor if the project has frontend code (it will cleanly return n/a otherwise).",
    "- Integrate findings into a single verdict: approved OR requested_changes (with summary).",
    "- Set nextPhase=\"development\" when requested_changes AND the issues are fixable by dev.",
    "- Set nextPhase=\"staging\" when approved.",
  ].join("\n"),
  deliverables: [
    "status: one of ['approved', 'requested_changes']",
    "summary: (required when status=requested_changes) short prose summary of critical findings",
  ],
  // review → development (backloop) or review → staging (forward) per
  // VALID_TRANSITIONS in project-state.ts.
  allowedNextPhases: ["development", "staging"],
  outputSchema: ReviewResultSchema,
  outputShapeHint: `{
  "status": "approved" | "requested_changes",
  "summary": "Required when status=requested_changes. Short prose of critical findings. Omit or empty-string when approved."
}`,
  specialistNames: ["security-auditor", "accessibility-auditor"],
  contextSelector: reviewContextSelector,
  // Livelock guard: don't let review bounce code back to dev more than 3x.
  maxBackloopsFromHere: { development: 3 },
};
