import type { ProjectState } from "../../state/project-state.js";
import type { PhaseContract, PhaseContext } from "../phase-contract.js";
import { TestingResultSchema } from "../../types/llm-schemas.js";
import type { z } from "zod";

type TestingResultParsed = z.infer<typeof TestingResultSchema>;

function testingContextSelector(state: ProjectState): PhaseContext {
  const summary: string[] = [];
  const slices: Record<string, unknown> = {};

  if (state.spec) {
    summary.push(`User stories: ${state.spec.userStories.length}`);
    summary.push(`NFRs: ${state.spec.nonFunctionalRequirements.length}`);
    // Acceptance criteria are the testing contract — pass them verbatim.
    slices["acceptanceCriteria"] = state.spec.userStories.map((us) => ({
      id: us.id,
      title: us.title,
      criteria: us.acceptanceCriteria,
    }));
  }
  if (state.tasks.length > 0) {
    const done = state.tasks.filter((t) => t.status === "completed").length;
    summary.push(`Tasks complete: ${done}/${state.tasks.length}`);
  }

  const testingHistory = state.phaseAttempts?.["testing"] ?? [];
  if (testingHistory.length > 0) {
    slices["priorTestingAttempts"] = testingHistory.slice(-3);
  }

  return { summary, slices };
}

/**
 * v1.1 super-lead contract for the testing phase.
 *
 * Lead runs the actual test commands (npm test, lint, typecheck) and
 * delegates to edge-case-finder + property-tester to enumerate coverage
 * gaps. If failures exist, nextPhase=development (backloop capped at 3).
 */
export const testingContract: PhaseContract<TestingResultParsed> = {
  phase: "testing",
  goals: [
    "Validate the implemented project against its acceptance criteria.",
    "",
    "Responsibilities:",
    "- Run the project's own test commands (npm test, npm run lint, npm run typecheck) via Bash.",
    "- Invoke edge-case-finder to enumerate cases the primary plan missed.",
    "- Invoke property-tester to identify invariants worth property-testing.",
    "- Set nextPhase=\"development\" when failures are fixable (backloop).",
    "- Set nextPhase=\"review\" when all tests pass.",
  ].join("\n"),
  deliverables: [
    "status: one of ['passed', 'failed']",
    "details: (required when status=failed) short prose of the failure categories",
  ],
  // testing → development (backloop) or testing → review (forward) per
  // VALID_TRANSITIONS in project-state.ts.
  allowedNextPhases: ["development", "review"],
  outputSchema: TestingResultSchema,
  outputShapeHint: `{
  "status": "passed" | "failed",
  "details": "Required when status=failed. Short prose of failure categories. Omit or empty-string when passed."
}`,
  specialistNames: ["edge-case-finder", "property-tester"],
  contextSelector: testingContextSelector,
  // Livelock guard: cap the testing↔development ping-pong at 3 rounds.
  maxBackloopsFromHere: { development: 3 },
};
