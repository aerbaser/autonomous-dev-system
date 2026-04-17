import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../utils/config.js";
import type { ProjectState, Deployment } from "../state/project-state.js";
import type { PhaseResult, PhaseExecutionContext } from "./types.js";
import { randomUUID } from "node:crypto";
import { consumeQuery, getQueryPermissions, getMaxTurns, QueryAbortedError } from "../utils/sdk-helpers.js";
import { errMsg } from "../utils/shared.js";
import { DeploymentResultSchema } from "../types/llm-schemas.js";

export async function runDeployment(
  state: ProjectState,
  config: Config,
  ctx?: PhaseExecutionContext
): Promise<PhaseResult> {
  const environment: "staging" | "production" = state.currentPhase === "staging" ? "staging" : "production";
  console.log(`[deploy] Deploying to ${environment}...`);
  const signal = ctx?.signal;

  const prompt = `You are a DevOps Engineer. Deploy this project to ${environment}.

Steps:
1. Ensure CI/CD pipeline is set up (GitHub Actions or equivalent)
2. Build the project (npm run build or equivalent)
3. If Docker is configured, build and tag the image
4. Deploy to ${environment}
5. Run health checks
6. Report deployment status

If this is a staging deploy, set up with feature flags for A/B testing.
If this is a production deploy, ensure rollback plan is in place.

Report the deployment URL if available.

After completing all steps, output your final assessment as JSON:
{"status": "deployed", "url": "<deployment-url>"}
or
{"status": "failed", "reason": "<failure-reason>"}`;

  let resultText: string;
  let structuredOutput: unknown;
  let costUsd: number | undefined;
  try {
    const queryResult = await consumeQuery(
      query({
        prompt,
        options: {
          tools: ["Read", "Write", "Edit", "Bash", "Glob"],
          ...getQueryPermissions(config),
          maxTurns: getMaxTurns(config, "deployment"),
        },
      }),
      { label: "deployment", ...(signal ? { signal } : {}) }
    );
    resultText = queryResult.result;
    structuredOutput = queryResult.structuredOutput;
    costUsd = queryResult.cost;
  } catch (err) {
    if (err instanceof QueryAbortedError) {
      return { success: false, state, error: "aborted" };
    }
    console.error(`[deploy] Query failed: ${errMsg(err)}`);
    const deployment: Deployment = {
      id: randomUUID(),
      environment,
      timestamp: new Date().toISOString(),
      status: "failed",
    };
    const newState: ProjectState = {
      ...state,
      deployments: [...state.deployments, deployment],
    };
    return { success: false, state: newState, error: "Deployment query failed" };
  }

  // Try structured output first, fall back to text parsing
  let deployed = false;
  let deployUrl: string | undefined;

  const parsed = structuredOutput != null ? DeploymentResultSchema.safeParse(structuredOutput) : null;
  if (parsed?.success) {
    deployed = parsed.data.status === "deployed";
    deployUrl = parsed.data.url;
  } else {
    // Fallback: text parsing
    const deployLine = resultText
      .split("\n")
      .find((l) => l.startsWith("DEPLOYED:") || l.startsWith("FAILED:"));
    deployed = deployLine?.startsWith("DEPLOYED:") ?? false;
    if (deployed && deployLine) {
      deployUrl = deployLine.replace("DEPLOYED:", "").trim();
    }
  }

  const deployment: Deployment = {
    id: randomUUID(),
    environment,
    timestamp: new Date().toISOString(),
    status: deployed ? "deployed" : "failed",
    ...(deployUrl ? { url: deployUrl } : {}),
  };

  const newState: ProjectState = {
    ...state,
    deployments: [...state.deployments, deployment],
  };

  if (deployment.status === "deployed") {
    console.log(`[deploy] Successfully deployed to ${environment}: ${deployment.url ?? "no URL"}`);
    const nextPhase = environment === "staging" ? "ab-testing" : "monitoring";
    return { success: true, nextPhase, state: newState, ...(costUsd != null ? { costUsd } : {}) };
  } else {
    console.log(`[deploy] Deployment failed`);
    return { success: false, state: newState, error: "Deployment failed", ...(costUsd != null ? { costUsd } : {}) };
  }
}
