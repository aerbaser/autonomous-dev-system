import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../utils/config.js";
import type { ProjectState } from "../state/project-state.js";
import type { PhaseResult, PhaseExecutionContext } from "./types.js";
import { consumeQuery, getQueryPermissions, getMaxTurns } from "../utils/sdk-helpers.js";
import { extractFirstJson, errMsg, wrapUserInput } from "../utils/shared.js";
import { AnalysisResultSchema, type AnalysisResult } from "../types/llm-schemas.js";

const ANALYSIS_SYSTEM_PROMPT = `You are a Senior Release Analyst. Given A/B test results and
deployment metrics, produce a concise ship/rollback/extend recommendation.

Output a single JSON object with this exact shape:

{
  "winningVariant": "control | variant_a | variant_b | null (if no A/B data)",
  "statisticalConfidence": 0.95,
  "recommendedAction": "ship | rollback | extend | proceed",
  "metricsSummary": "2-3 sentence plain-English summary of what the numbers say",
  "rationale": "2-4 sentence justification that connects metrics to the recommendation"
}

Decision rules:
- "ship": A/B winner with p < 0.05 and no regression; or deployment healthy without A/B data.
- "rollback": error rate spike, critical regression, or losing variant worse than control.
- "extend": indeterminate A/B (p >= 0.05 or insufficient sample); keep running.
- "proceed": no A/B data and deployment looks healthy — proceed to production without extra analysis.

If A/B data is absent, omit "winningVariant" and "statisticalConfidence" and pick "proceed" or "rollback" based on deployment metrics alone.

Output the JSON object only. No prose before or after.`;

function summarizeABTests(state: ProjectState): string {
  if (state.abTests.length === 0) return "(no A/B tests run)";
  return state.abTests
    .map((t) => {
      const r = t.result;
      const resultStr = r
        ? `winner=${r.winner}, p=${r.pValue}, metrics=${JSON.stringify(r.metrics)}`
        : "(no result recorded)";
      return `- ${t.name} [${t.status}] — hypothesis: ${t.hypothesis}\n    variants: ${t.variants.join(" vs ")}\n    ${resultStr}`;
    })
    .join("\n");
}

function summarizeDeployments(state: ProjectState): string {
  if (state.deployments.length === 0) return "(no deployments recorded)";
  return state.deployments
    .slice(-5)
    .map(
      (d) =>
        `- ${d.environment} [${d.status}] at ${d.timestamp}${d.url ? ` url=${d.url}` : ""}`,
    )
    .join("\n");
}

export async function runAnalysis(
  state: ProjectState,
  config: Config,
  _ctx?: PhaseExecutionContext,
): Promise<PhaseResult> {
  console.log("[analysis] Analyzing A/B test results and deployment metrics...");

  const abSummary = summarizeABTests(state);
  const deploySummary = summarizeDeployments(state);
  const hasABData = state.abTests.some((t) => t.result != null);

  // Graceful minimal path: no A/B data and no deployment data — emit a minimal
  // "proceed" analysis without calling the LLM so we don't spend money on a
  // trivial decision.
  if (!hasABData && state.deployments.length === 0) {
    const minimal: AnalysisResult = {
      recommendedAction: "proceed",
      metricsSummary: "No A/B data and no deployments yet — nothing to analyze.",
      rationale: "Minimal analysis emitted because no A/B tests or deployments were present in state.",
    };
    console.log("[analysis] No data available — emitting minimal proceed recommendation");
    return {
      success: true,
      nextPhase: "production",
      state: {
        ...state,
        analysis: {
          ...minimal,
          timestamp: new Date().toISOString(),
        },
      },
    };
  }

  const perCallPrompt = `${wrapUserInput("ab-tests", abSummary)}

${wrapUserInput("deployments", deploySummary)}

${wrapUserInput("has-ab-data", hasABData ? "yes" : "no")}`;

  let analysisText: string;
  let costUsd: number | undefined;
  try {
    const queryResult = await consumeQuery(
      query({
        prompt: perCallPrompt,
        options: {
          // Static instructions go into `systemPrompt` so the SDK's ephemeral
          // cache can hit across rubric retries. Per-call prompt carries only
          // the project-specific A/B + deployment context.
          systemPrompt: ANALYSIS_SYSTEM_PROMPT,
          ...getQueryPermissions(config),
          maxTurns: getMaxTurns(config, "analysis"),
        },
      }),
      "analysis",
    );
    analysisText = queryResult.result;
    costUsd = queryResult.cost;
  } catch (err) {
    return {
      success: false,
      state,
      error: `Failed to run analysis: ${errMsg(err)}`,
    };
  }

  const jsonStr = extractFirstJson(analysisText);
  if (!jsonStr) {
    console.warn("[analysis] text fallback used — LLM did not return JSON");
    const fallback: AnalysisResult = {
      recommendedAction: hasABData ? "extend" : "proceed",
      metricsSummary: analysisText.slice(0, 500),
      rationale: "Falling back because analysis LLM did not produce JSON output.",
    };
    return {
      success: true,
      nextPhase: "production",
      state: {
        ...state,
        analysis: { ...fallback, timestamp: new Date().toISOString() },
      },
      ...(costUsd != null ? { costUsd } : {}),
    };
  }

  const parsed = AnalysisResultSchema.safeParse(JSON.parse(jsonStr));
  if (!parsed.success) {
    return {
      success: false,
      state,
      error: `analysis: invalid AnalysisResult JSON — ${parsed.error.message}`,
      ...(costUsd != null ? { costUsd } : {}),
    };
  }

  const result: AnalysisResult = parsed.data;

  console.log(
    `[analysis] Recommendation: ${result.recommendedAction}` +
      (result.winningVariant ? ` (winner: ${result.winningVariant})` : "") +
      (result.statisticalConfidence != null
        ? ` confidence=${result.statisticalConfidence}`
        : ""),
  );

  const nextPhase = result.recommendedAction === "rollback" ? "development" : "production";

  return {
    success: true,
    nextPhase,
    state: {
      ...state,
      analysis: { ...result, timestamp: new Date().toISOString() },
    },
    ...(costUsd != null ? { costUsd } : {}),
  };
}
