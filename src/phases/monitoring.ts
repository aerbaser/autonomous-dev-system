import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../utils/config.js";
import type { ProjectState } from "../state/project-state.js";
import type { PhaseResult } from "../orchestrator.js";
import { getMcpServerConfigs } from "../environment/mcp-manager.js";
import { consumeQuery } from "../utils/sdk-helpers.js";

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

End with one of:
- "HEALTHY: all metrics normal"
- "REGRESSION: <description>" (-> triggers development cycle)
- "IMPROVEMENT: <hypothesis>" (-> triggers new feature cycle)`;

  let resultText: string;
  try {
    const { result } = await consumeQuery(
      query({
        prompt,
        options: {
          tools: ["Bash", "WebFetch"],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: 10,
          mcpServers,
        },
      }),
      "monitoring"
    );
    resultText = result;
  } catch (err) {
    console.error(`[monitoring] Query failed: ${err instanceof Error ? err.message : String(err)}`);
    return { success: false, state, error: err instanceof Error ? err.message : String(err) };
  }

  const lastLine = resultText.trim().split("\n").pop()?.trim() ?? "";

  if (lastLine.startsWith("REGRESSION:") || lastLine.startsWith("IMPROVEMENT:")) {
    console.log(`[monitoring] Action needed: ${lastLine}`);
    return { success: true, nextPhase: "development", state };
  }

  console.log("[monitoring] System healthy");
  return { success: true, state };
}
