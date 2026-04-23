import type { ProjectState } from "../../state/project-state.js";
import type { PhaseContract, PhaseContext } from "../phase-contract.js";
import { DetailedSpecSchema } from "../../types/llm-schemas.js";
import type { z } from "zod";

type DetailedSpecParsed = z.infer<typeof DetailedSpecSchema>;

function specificationContextSelector(state: ProjectState): PhaseContext {
  const summary: string[] = [];
  const slices: Record<string, unknown> = {};

  summary.push(`Idea: ${state.idea}`);
  if (state.spec) {
    summary.push(`Domain: ${state.spec.domain.classification}`);
    summary.push(`User stories (coarse): ${state.spec.userStories.length}`);
    summary.push(`NFRs (coarse): ${state.spec.nonFunctionalRequirements.length}`);

    slices["productSpec"] = {
      summary: state.spec.summary,
      userStories: state.spec.userStories,
      nonFunctionalRequirements: state.spec.nonFunctionalRequirements,
      domain: state.spec.domain,
      ...(state.spec.mvpScope ? { mvpScope: state.spec.mvpScope } : {}),
    };
  } else {
    summary.push("WARNING: no product spec available.");
  }

  return { summary, slices };
}

/**
 * v1.1 super-lead contract for the specification phase.
 *
 * Product-manager-class lead expands the coarse spec into implementation-
 * ready detail, delegating to:
 *   - nfr-analyst: replace vague NFRs with measurable thresholds
 *   - out-of-scope-guard: flag stories that drift from the stated idea
 *
 * Output: DetailedSpec — refinedUserStories, refinedNonFunctionalRequirements,
 * outOfScope, integrationBoundaries.
 */
export const specificationContract: PhaseContract<DetailedSpecParsed> = {
  phase: "specification",
  goals: [
    "Expand the coarse product spec into implementation-ready detail.",
    "",
    "Responsibilities:",
    "- Produce refinedUserStories with strictly Given/When/Then acceptance criteria.",
    "- Produce refinedNonFunctionalRequirements with measurable thresholds, not prose.",
    "- Enumerate outOfScope explicitly — stories and features the team WILL NOT build.",
    "- Enumerate integrationBoundaries (protocols, ownership, failure semantics).",
    "- Invoke nfr-analyst to turn vague NFRs into measurable thresholds.",
    "- Invoke out-of-scope-guard to surface stories that drift from the stated idea.",
  ].join("\n"),
  deliverables: [
    "refinedUserStories: array of {id, title, acceptanceCriteria[]}",
    "refinedNonFunctionalRequirements: array of measurable NFRs with threshold + measurement method",
    "outOfScope: array of explicit exclusions with one-line reasons",
    "integrationBoundaries: array of external-system integration contracts",
  ],
  // specification → architecture per VALID_TRANSITIONS. No backloop targets.
  allowedNextPhases: ["architecture"],
  outputSchema: DetailedSpecSchema,
  specialistNames: ["nfr-analyst", "out-of-scope-guard"],
  contextSelector: specificationContextSelector,
  maxBackloopsFromHere: {},
};
