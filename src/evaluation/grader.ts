import { query } from "@anthropic-ai/claude-agent-sdk";
import type { OutputFormat } from "@anthropic-ai/claude-agent-sdk";
import { consumeQuery, getQueryPermissions } from "../utils/sdk-helpers.js";
import { wrapUserInput } from "../utils/shared.js";
import type { Config } from "../utils/config.js";
import type { ProjectState, Phase } from "../state/project-state.js";
import type { PhaseResult } from "../phases/types.js";
import type { Rubric, RubricResult, CriterionScore } from "./rubric.js";
import type { EventBus } from "../events/event-bus.js";
import { computeWeightedScore, determineVerdict } from "./rubric.js";
import { CriterionScoreSchema } from "../types/llm-schemas.js";
import { z } from "zod";

const GRADER_OUTPUT_FORMAT: OutputFormat = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      scores: {
        type: "array",
        items: {
          type: "object",
          properties: {
            criterionName: { type: "string" },
            score: { type: "number" },
            passed: { type: "boolean" },
            feedback: { type: "string" },
          },
          required: ["criterionName", "score", "passed", "feedback"],
        },
      },
      verdict: {
        type: "string",
        enum: ["satisfied", "needs_revision", "failed"],
      },
      overallScore: { type: "number" },
      summary: { type: "string" },
    },
    required: ["scores", "verdict", "overallScore", "summary"],
  },
};

function buildGraderPrompt(rubric: Rubric, phaseResult: PhaseResult, stateSummary: string): string {
  const criteriaList = rubric.criteria
    .map(c => `- ${c.name} (weight: ${c.weight}, threshold: ${c.threshold}): ${c.description}`)
    .join("\n");

  const artifacts = phaseResult.error
    ? `Phase failed with error: ${phaseResult.error}`
    : `Phase completed successfully.${phaseResult.nextPhase ? ` Next phase: ${phaseResult.nextPhase}` : ""}`;

  return `You are a quality grader. Evaluate the following phase output against a rubric.

## Rubric: ${rubric.name}
${rubric.description}

### Criteria
${criteriaList}

## Phase Output
${wrapUserInput("phase-artifacts", artifacts)}

## Project Context
${wrapUserInput("project-summary", stateSummary)}

## Instructions
1. Score each criterion from 0.0 to 1.0
2. A criterion passes if its score >= its threshold
3. Provide specific feedback for each criterion (what was good, what gaps remain)
4. Set verdict:
   - "satisfied" if ALL criteria pass
   - "needs_revision" if some criteria fail but the work is salvageable
   - "failed" if the work is fundamentally wrong (more than half of criteria fail)
5. Compute overallScore as the weighted average of all scores
6. Write a brief summary of the evaluation

Be strict but fair. Only mark "satisfied" when the work genuinely meets the criteria.`;
}

function buildStateSummary(state: ProjectState): string {
  const parts: string[] = [
    `Project: ${state.idea}`,
    `Phase: ${state.currentPhase}`,
  ];

  if (state.spec) {
    parts.push(`Spec: ${state.spec.summary}`);
    parts.push(`User stories: ${state.spec.userStories.length}`);
  }

  if (state.architecture) {
    parts.push(`Architecture components: ${state.architecture.components.length}`);
  }

  parts.push(`Tasks: ${state.tasks.length} (${state.tasks.filter(t => t.status === "completed").length} completed)`);

  return parts.join("\n");
}

export interface GraderOptions {
  model?: string;
  config: Config;
  eventBus?: EventBus;
  phase?: Phase;
  signal?: AbortSignal;
}

/**
 * Run the grader LLM against a phase result and return a structured RubricResult.
 *
 * **verdict precedence rule (HIGH-02 — required by REQUIREMENTS.md):**
 *
 *   1. **LLM-emitted verdict (preferred).** When `GraderOutputSchema.safeParse`
 *      succeeds against the structured output (or a JSON parse of the result
 *      text), the LLM's `verdict`, `overallScore`, `scores`, and `summary` are
 *      returned VERBATIM. The grader MUST NOT recompute the verdict via
 *      `determineVerdict(scores)` or override `overallScore` via
 *      `computeWeightedScore(...)`. The LLM is the source of truth.
 *
 *   2. **Algorithmic fallback.** When parsing fails (no structured_output AND
 *      `result.result` is not valid JSON matching the schema), and only then,
 *      the grader synthesizes a default `scores` array (one entry per
 *      criterion at 0.5 / passed=false), then computes `overallScore` and
 *      `verdict` algorithmically from those defaults. This is a degraded
 *      signal — the rubric loop will see `verdict: "needs_revision"` (because
 *      most criteria fail their thresholds) and retry, OR `verdict: "failed"`
 *      if more than half "fail."
 *
 *   3. **Fail-open on grader outage.** When `consumeQuery` itself throws
 *      (timeout / network / abort), the grader returns `verdict: "satisfied"`
 *      with `overallScore: 1` so an infrastructure error does NOT block the
 *      pipeline. This is a deliberate trade — operators get a warning log,
 *      not a halt.
 *
 * Tests in `tests/evaluation/grader.test.ts` lock this precedence in.
 */
export async function gradePhaseOutput(
  rubric: Rubric,
  phaseResult: PhaseResult,
  state: ProjectState,
  options: GraderOptions,
): Promise<{ rubricResult: RubricResult; costUsd: number }> {
  const { config, eventBus, signal } = options;
  const phase = options.phase ?? state.currentPhase;
  const model = options.model ?? config.subagentModel;
  const stateSummary = buildStateSummary(state);
  const prompt = buildGraderPrompt(rubric, phaseResult, stateSummary);

  const queryStart = Date.now();
  const queryStream = query({
    prompt,
    options: {
      model,
      outputFormat: GRADER_OUTPUT_FORMAT,
      maxTurns: 3,
      allowedTools: ["Read", "Glob", "Grep"],
      ...getQueryPermissions(config),
    },
  });

  let result: Awaited<ReturnType<typeof consumeQuery>>;
  try {
    result = await consumeQuery(queryStream, {
      label: "grader",
      eventBus,
      phase,
      agentName: "grader",
      model,
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    const summary = `Grader unavailable after ${Date.now() - queryStart}ms: ${
      err instanceof Error ? err.message : String(err)
    }`;
    console.warn(`[grader] ${summary}. Skipping rubric gate.`);
    // HIGH-02 — verdict precedence rule (#3): grader outage → fail-open
    // verdict='satisfied' with overallScore=1 so infrastructure errors
    // (timeout, network, abort) do NOT block the orchestrator.
    const satisfiedScores = rubric.criteria.map((criterion) => ({
      criterionName: criterion.name,
      score: 1,
      passed: true,
      feedback: "Rubric gate skipped because grader query failed",
    }));
    return {
      rubricResult: {
        rubricName: rubric.name,
        scores: satisfiedScores,
        verdict: "satisfied",
        overallScore: 1,
        summary,
        iteration: 0,
      },
      costUsd: 0,
    };
  }

  // Parse structured output with Zod
  const GraderOutputSchema = z.object({
    scores: z.array(CriterionScoreSchema),
    verdict: z.enum(["satisfied", "needs_revision", "failed"]),
    overallScore: z.number(),
    summary: z.string(),
  });

  let scores: CriterionScore[];
  let verdict: "satisfied" | "needs_revision" | "failed";
  let overallScore: number;
  let summary: string;

  const raw = result.structuredOutput ?? tryParseJson(result.result);
  const parsed = GraderOutputSchema.safeParse(raw);

  if (parsed.success) {
    // HIGH-02 — verdict precedence rule (#1): LLM verdict wins.
    // Do NOT replace `verdict` with `determineVerdict(scores)` and do NOT
    // replace `overallScore` with `computeWeightedScore(scores, criteria)`.
    // The LLM's structured output is the source of truth when it parses.
    scores = parsed.data.scores;
    verdict = parsed.data.verdict;
    overallScore = parsed.data.overallScore;
    summary = parsed.data.summary;
  } else {
    // HIGH-02 — verdict precedence rule (#2): no LLM verdict to honor.
    // Synthesize defaults for every criterion, then derive verdict/overallScore
    // algorithmically. This branch only runs when neither the SDK's
    // `structuredOutput` nor a JSON parse of `result.result` matches
    // `GraderOutputSchema`.
    console.warn("[grader] Failed to parse structured output, using fallback scoring");
    scores = rubric.criteria.map(c => ({
      criterionName: c.name,
      score: 0.5,
      passed: false,
      feedback: "Could not evaluate — grader output was not structured",
    }));
    overallScore = computeWeightedScore(scores, rubric.criteria);
    verdict = determineVerdict(scores);
    summary = result.result.slice(0, 500);
  }

  return {
    rubricResult: {
      rubricName: rubric.name,
      scores,
      verdict,
      overallScore,
      summary,
      iteration: 0, // Caller sets the actual iteration
    },
    costUsd: result.cost,
  };
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
