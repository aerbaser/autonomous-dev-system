import type { Config } from "../utils/config.js";
import type { PhaseResult } from "../phases/types.js";
import type { Phase } from "../state/project-state.js";
import type { Rubric, RubricResult, EvaluatedPhaseResult } from "./rubric.js";
import type { EventBus } from "../events/event-bus.js";
import { gradePhaseOutput } from "./grader.js";

/**
 * Run a phase handler, then grade the output. If the grader says "needs_revision",
 * inject the gaps as feedback and re-run the handler up to maxIterations times.
 *
 * On "failed" verdict, returns immediately — no point iterating on fundamentally wrong work.
 * On "satisfied", returns immediately — work meets the rubric.
 */
export async function evaluateWithRubric(
  handler: () => Promise<PhaseResult>,
  config: Config,
  rubric: Rubric,
  maxIterations: number,
  options?: { eventBus?: EventBus | undefined; phase?: Phase | undefined },
): Promise<EvaluatedPhaseResult> {
  const eventBus = options?.eventBus;
  const phase = options?.phase ?? ("unknown" as Phase);
  let lastResult: PhaseResult | null = null;
  let lastRubricResult: RubricResult | null = null;
  let totalCost = 0;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    eventBus?.emit("evaluation.rubric.start", {
      phase,
      rubricName: rubric.name,
      iteration,
    });

    // Run the phase handler
    const phaseResult = await handler();
    lastResult = phaseResult;

    if (phaseResult.costUsd) {
      totalCost += phaseResult.costUsd;
    }

    // If the phase itself failed, don't grade — just return
    if (!phaseResult.success) {
      eventBus?.emit("evaluation.rubric.end", {
        phase,
        rubricName: rubric.name,
        result: "failed",
        iteration,
      });
      return {
        ...phaseResult,
        rubricResult: {
          rubricName: rubric.name,
          scores: [],
          verdict: "failed",
          overallScore: 0,
          summary: `Phase handler failed: ${phaseResult.error ?? "unknown error"}`,
          iteration,
        },
        totalIterations: iteration,
      };
    }

    // Grade the output
    const graderModel = config.rubrics?.graderModel;
    const graderOptions = graderModel
      ? { model: graderModel, config }
      : { config };
    const { rubricResult, costUsd: graderCost } = await gradePhaseOutput(
      rubric,
      phaseResult,
      phaseResult.state,
      graderOptions,
    );

    totalCost += graderCost;
    rubricResult.iteration = iteration;
    lastRubricResult = rubricResult;

    console.log(
      `[rubric] Iteration ${iteration}/${maxIterations}: verdict=${rubricResult.verdict}, ` +
      `score=${rubricResult.overallScore.toFixed(2)}`
    );

    // If satisfied or failed, stop iterating
    if (rubricResult.verdict === "satisfied" || rubricResult.verdict === "failed") {
      eventBus?.emit("evaluation.rubric.end", {
        phase,
        rubricName: rubric.name,
        result: rubricResult.verdict,
        iteration,
      });
      return {
        ...phaseResult,
        costUsd: totalCost,
        rubricResult,
        totalIterations: iteration,
      };
    }

    // needs_revision: log gaps for next iteration
    if (iteration < maxIterations) {
      const gaps = rubricResult.scores
        .filter(s => !s.passed)
        .map(s => `- ${s.criterionName}: ${s.feedback}`)
        .join("\n");

      console.log(`[rubric] Gaps to address:\n${gaps}`);
      // The handler will be called again in the next iteration.
      // The caller is responsible for injecting feedback into the handler's context
      // (e.g., via updated state or re-constructed prompt).
    }
  }

  // Exhausted iterations — return last result with last rubric result
  eventBus?.emit("evaluation.rubric.end", {
    phase,
    rubricName: rubric.name,
    result: lastRubricResult?.verdict ?? "needs_revision",
    iteration: maxIterations,
  });
  return {
    ...(lastResult as PhaseResult),
    costUsd: totalCost,
    rubricResult: lastRubricResult as RubricResult,
    totalIterations: maxIterations,
  };
}
