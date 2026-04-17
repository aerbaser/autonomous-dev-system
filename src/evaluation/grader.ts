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

  eventBus?.emit("agent.query.start", {
    phase,
    agentName: "grader",
    model,
    promptLength: prompt.length,
  });

  const queryStart = Date.now();
  const queryStream = query({
    prompt,
    options: {
      model,
      outputFormat: GRADER_OUTPUT_FORMAT,
      maxTurns: 1,
      allowedTools: ["Read", "Glob", "Grep"],
      ...getQueryPermissions(config),
    },
  });

  const result = await consumeQuery(queryStream, { label: "grader", ...(signal ? { signal } : {}) });

  eventBus?.emit("agent.query.end", {
    phase,
    agentName: "grader",
    inputTokens: 0,
    outputTokens: 0,
    costUsd: result.cost,
    durationMs: Date.now() - queryStart,
    success: true,
  });

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
    scores = parsed.data.scores;
    verdict = parsed.data.verdict;
    overallScore = parsed.data.overallScore;
    summary = parsed.data.summary;
  } else {
    // Fallback: construct minimal result from text
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
