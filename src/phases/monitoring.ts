import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../utils/config.js";
import type { ProjectState } from "../state/project-state.js";
import type { PhaseResult } from "../orchestrator.js";
import { getMcpServerConfigs } from "../environment/mcp-manager.js";
import { consumeQuery, getQueryPermissions, getMaxTurns } from "../utils/sdk-helpers.js";
import { MonitoringResultSchema } from "../types/llm-schemas.js";

export async function runMonitoring(
  state: ProjectState,
  config: Config
): Promise<PhaseResult> {
  const mcpServers = state.environment
    ? getMcpServerConfigs(state.environment.mcpServers)
    : {};

  console.log("[monitoring] Checking production health...");

  const prompt = `You are a Production Monitor. Check the health and metrics of this product.

Deployments:
${state.deployments.filter((d) => d.status === "deployed").map((d) => `${d.environment}: ${d.url}`).join("\n")}

Check:
1. Application health (endpoints responding?)
2. Error rates (any regressions?)
3. User metrics (if PostHog available: active users, retention, key funnels)
4. Performance metrics (response times, error rates)

Based on findings:
- If there are regressions -> suggest fixes and recommend going back to development
- If metrics are stagnating -> suggest an improvement hypothesis
- If everything is healthy -> report "HEALTHY"

After completing all checks, output your assessment as JSON:
{"status": "healthy", "description": "all metrics normal"}
or
{"status": "regression", "description": "<what regressed>"}
or
{"status": "improvement", "description": "<improvement hypothesis>"}`;

  let resultText: string;
  let structuredOutput: unknown;
  try {
    const queryResult = await consumeQuery(
      query({
        prompt,
        options: {
          tools: ["Bash", "WebFetch"],
          ...getQueryPermissions(config),
          maxTurns: getMaxTurns(config, "monitoring"),
          mcpServers,
        },
      }),
      "monitoring"
    );
    resultText = queryResult.result;
    structuredOutput = queryResult.structuredOutput;
  } catch (err) {
    console.error(`[monitoring] Query failed: ${err instanceof Error ? err.message : String(err)}`);
    return { success: false, state, error: err instanceof Error ? err.message : String(err) };
  }

  // Try structured output first, fall back to text parsing
  let status: "healthy" | "regression" | "improvement" = "healthy";

  const parsed = structuredOutput != null ? MonitoringResultSchema.safeParse(structuredOutput) : null;
  if (parsed?.success) {
    status = parsed.data.status;
    if (status !== "healthy") {
      console.log(`[monitoring] Action needed: ${parsed.data.description}`);
    }
  } else {
    // Fallback: text parsing
    const lastLine = resultText.trim().split("\n").pop()?.trim() ?? "";
    if (lastLine.startsWith("REGRESSION:")) status = "regression";
    else if (lastLine.startsWith("IMPROVEMENT:")) status = "improvement";
    if (status !== "healthy") {
      console.log(`[monitoring] Action needed: ${lastLine}`);
    }
  }

  if (status === "regression" || status === "improvement") {
    return { success: true, nextPhase: "development", state };
  }

  console.log("[monitoring] System healthy");
  return { success: true, state };
}
