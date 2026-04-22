import type { Config } from "../utils/config.js";
import type { PhaseResult } from "../phases/types.js";
import type { Phase } from "../state/project-state.js";
import type { Rubric, RubricResult, EvaluatedPhaseResult } from "./rubric.js";
import type { EventBus } from "../events/event-bus.js";
import { gradePhaseOutput } from "./grader.js";
import { getActiveLedger } from "../state/run-ledger.js";
import { errMsg } from "../utils/shared.js";

/**
 * HIGH-01: Best-effort escalation of a `failed` rubric verdict into the active
 * RunLedger with reason code `verification_failed`. No-op if no ledger is set
 * (e.g. unit tests that don't bootstrap an orchestrator). Errors are swallowed
 * — a ledger failure must never mask the actual phase outcome being reported.
 */
function escalateRubricFailureToLedger(
  phase: Phase | undefined,
  rubric: Rubric,
  rubricResult: RubricResult,
  config: Config,
): void {
  if (!phase) return;
  try {
    const ledger = getActiveLedger();
    if (!ledger) return;
    const graderModel = config.rubrics?.graderModel ?? config.subagentModel;
    const session = ledger.startSession({
      phase,
      role: "rubric-grader",
      sessionType: "rubric",
      ...(graderModel ? { model: graderModel } : {}),
    });
    const message =
      rubricResult.summary && rubricResult.summary.trim().length > 0
        ? rubricResult.summary
        : `Rubric "${rubric.name}" failed at iteration ${rubricResult.iteration} with overall score ${rubricResult.overallScore.toFixed(2)}`;
    ledger.recordFailure(session.sessionId, "verification_failed", message);
    ledger.endSession(session.sessionId, { success: false });
    console.log(
      `[ledger] verification_failed recorded for phase "${phase}" (rubric "${rubric.name}")`,
    );
  } catch (err) {
    console.warn(
      `[ledger] Failed to record verification_failed escalation: ${errMsg(err)}`,
    );
  }
}

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
  const phase = options?.phase;
  let lastResult: PhaseResult | null = null;
  let lastRubricResult: RubricResult | null = null;
  let totalCost = 0;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    if (phase !== undefined) {
      eventBus?.emit("evaluation.rubric.start", {
        phase,
        rubricName: rubric.name,
        iteration,
      });
    }

    // Run the phase handler
    const phaseResult = await handler();
    lastResult = phaseResult;

    if (phaseResult.costUsd) {
      totalCost += phaseResult.costUsd;
    }

    // If the phase itself failed, don't grade — just return
    if (!phaseResult.success) {
      if (phase !== undefined) {
        eventBus?.emit("evaluation.rubric.end", {
          phase,
          rubricName: rubric.name,
          result: "failed",
          iteration,
        });
      }
      const syntheticFailedResult: RubricResult = {
        rubricName: rubric.name,
        scores: [],
        verdict: "failed",
        overallScore: 0,
        summary: `Phase handler failed: ${phaseResult.error ?? "unknown error"}`,
        iteration,
      };
      escalateRubricFailureToLedger(phase, rubric, syntheticFailedResult, config);
      return {
        ...phaseResult,
        costUsd: totalCost,
        rubricResult: syntheticFailedResult,
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
      if (phase !== undefined) {
        eventBus?.emit("evaluation.rubric.end", {
          phase,
          rubricName: rubric.name,
          result: rubricResult.verdict,
          iteration,
        });
      }
      if (rubricResult.verdict === "failed") {
        escalateRubricFailureToLedger(phase, rubric, rubricResult, config);
      }
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
  if (phase !== undefined) {
    eventBus?.emit("evaluation.rubric.end", {
      phase,
      rubricName: rubric.name,
      result: lastRubricResult?.verdict ?? "needs_revision",
      iteration: maxIterations,
    });
  }
  if (!lastResult) throw new Error("evaluateWithRubric: no result after iterations");
  if (!lastRubricResult) throw new Error("evaluateWithRubric: no rubric result after iterations");
  return {
    ...lastResult,
    costUsd: totalCost,
    rubricResult: lastRubricResult,
    totalIterations: maxIterations,
  };
}
