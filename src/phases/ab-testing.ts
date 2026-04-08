import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../utils/config.js";
import type { ProjectState, ABTest } from "../state/project-state.js";
import type { PhaseResult } from "./types.js";
import { getMcpServerConfigs } from "../environment/mcp-manager.js";
import { randomUUID } from "node:crypto";
import { consumeQuery, getQueryPermissions, getMaxTurns } from "../utils/sdk-helpers.js";
import { ABTestDesignResponseSchema, ABTestAnalysisSchema } from "../types/llm-schemas.js";
import { extractFirstJson, errMsg, wrapUserInput } from "../utils/shared.js";

export async function runABTesting(
  state: ProjectState,
  config: Config
): Promise<PhaseResult> {
  const mcpServers = state.environment
    ? getMcpServerConfigs(state.environment.mcpServers)
    : {};

  // Check if we have active tests to analyze
  const activeTests = state.abTests.filter((t) => t.status === "running");
  if (activeTests.length > 0) {
    return analyzeTests(state, config, activeTests, mcpServers);
  }

  // Otherwise, create a new A/B test
  console.log("[ab-test] Designing A/B experiment...");

  const prompt = `You are an Analytics Engineer. Design an A/B test for this product.

${wrapUserInput("product-context", state.spec?.summary ?? state.idea)}

Active deployments:
${state.deployments.filter((d) => d.status === "deployed").map((d) => `${d.environment}: ${d.url}`).join("\n")}

Design an experiment:
1. Formulate a hypothesis (e.g., "Adding feature X will increase conversion by Y%")
2. Define the control and variant
3. Specify the primary metric and minimum detectable effect
4. Define the feature flag key

Output JSON:
{
  "name": "experiment-name",
  "hypothesis": "Changing X will improve Y by Z%",
  "variants": ["control", "variant_a"],
  "featureFlagKey": "experiment-name-flag",
  "primaryMetric": "metric-name",
  "minimumDetectableEffect": 0.05
}`;

  let resultText: string;
  let costUsd: number | undefined;
  try {
    const { result, cost } = await consumeQuery(
      query({
        prompt,
        options: {
          tools: ["Read", "Glob", "Grep", "WebFetch"],
          ...getQueryPermissions(config),
          maxTurns: getMaxTurns(config, "abTesting"),
          mcpServers,
        },
      }),
      "ab-test-design"
    );
    resultText = result;
    costUsd = cost;
  } catch (err) {
    return {
      success: false,
      state,
      error: `Failed to design A/B test: ${errMsg(err)}`,
    };
  }

  const jsonStr = extractFirstJson(resultText);
  if (!jsonStr) {
    return { success: false, state, error: "Failed to design A/B test" };
  }

  try {
    const parseResult = ABTestDesignResponseSchema.safeParse(JSON.parse(jsonStr));
    if (!parseResult.success) {
      return { success: false, state, error: "Failed to parse A/B test design" };
    }

    const design = parseResult.data;
    const test: ABTest = {
      id: randomUUID(),
      name: design.name,
      hypothesis: design.hypothesis,
      variants: design.variants,
      featureFlagKey: design.featureFlagKey,
      status: "running",
    };

    const newState: ProjectState = {
      ...state,
      abTests: [...state.abTests, test],
    };

    console.log(`[ab-test] Created: ${test.name} (${test.hypothesis})`);
    return { success: true, nextPhase: "analysis", state: newState, ...(costUsd != null ? { costUsd } : {}) };
  } catch {
    return { success: false, state, error: "Failed to parse A/B test design" };
  }
}

async function analyzeTests(
  state: ProjectState,
  config: Config,
  tests: ABTest[],
  mcpServers: Record<string, { command: string; args?: string[] }>
): Promise<PhaseResult> {
  console.log(`[ab-test] Analyzing ${tests.length} active tests...`);

  const prompt = `You are an Analytics Engineer. Analyze these A/B tests.

Active tests:
${tests.map((t) => `- ${t.name}: ${t.hypothesis} (flag: ${t.featureFlagKey})`).join("\n")}

Use PostHog MCP if available to check:
1. Sample size for each variant
2. Conversion rates
3. Statistical significance (p-value < 0.05)

For each test, output:
{
  "testId": "...",
  "winner": "control|variant_a|none",
  "pValue": 0.03,
  "metrics": { "conversion_rate_control": 0.12, "conversion_rate_variant": 0.15 },
  "recommendation": "Roll out variant / Keep running / Stop test"
}

Output a JSON array.`;

  let analysisText = "";
  let costUsd: number | undefined;
  try {
    const { result, cost } = await consumeQuery(
      query({
        prompt,
        options: {
          tools: ["WebFetch"],
          ...getQueryPermissions(config),
          maxTurns: getMaxTurns(config, "abTesting"),
          mcpServers,
        },
      }),
      "ab-test-analysis"
    );
    analysisText = result;
    costUsd = cost;
  } catch (err) {
    console.warn(`[ab-test] Analysis query failed: ${errMsg(err)}`);
  }

  // Parse analysis results and build a lookup by testId
  const analysisById = new Map<string, ABTest["result"]>();
  if (analysisText) {
    // Try to extract individual JSON objects for each test
    let remaining = analysisText;
    let jsonObj = extractFirstJson(remaining);
    while (jsonObj) {
      try {
        const parseResult = ABTestAnalysisSchema.safeParse(JSON.parse(jsonObj));
        if (parseResult.success) {
          const parsed = parseResult.data;
          if (parsed.testId && parsed.winner != null && parsed.pValue != null) {
            analysisById.set(parsed.testId, {
              winner: parsed.winner,
              pValue: parsed.pValue,
              metrics: parsed.metrics ?? {},
            });
          }
        }
      } catch { /* skip malformed */ }
      // Remove the parsed JSON from remaining text and continue
      const idx = remaining.indexOf(jsonObj);
      remaining = remaining.slice(idx + jsonObj.length);
      jsonObj = extractFirstJson(remaining);
    }
  }

  // Mark tests as completed and attach analysis results
  const completedTests = state.abTests.map((t) => {
    if (t.status !== "running") return t;
    const analysis = analysisById.get(t.id);
    return { ...t, status: "completed" as const, ...(analysis ? { result: analysis } : {}) };
  });

  const newState: ProjectState = {
    ...state,
    abTests: completedTests,
  };

  console.log("[ab-test] Analysis complete");
  return { success: true, nextPhase: "production", state: newState, ...(costUsd != null ? { costUsd } : {}) };
}
