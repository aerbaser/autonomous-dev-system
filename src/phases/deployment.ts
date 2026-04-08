import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../utils/config.js";
import type { ProjectState, Deployment } from "../state/project-state.js";
import type { PhaseResult } from "../orchestrator.js";
import { randomUUID } from "node:crypto";
import { consumeQuery } from "../utils/sdk-helpers.js";

export async function runDeployment(
  state: ProjectState,
  config: Config
): Promise<PhaseResult> {
  const environment: "staging" | "production" = state.currentPhase === "staging" ? "staging" : "production";
  console.log(`[deploy] Deploying to ${environment}...`);

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
End with: "DEPLOYED: <url>" or "FAILED: <reason>"`;

  let resultText: string;
  try {
    const { result } = await consumeQuery(
      query({
        prompt,
        options: {
          tools: ["Read", "Write", "Edit", "Bash", "Glob"],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: 20,
        },
      }),
      "deployment"
    );
    resultText = result;
  } catch (err) {
    console.error(`[deploy] Query failed: ${err instanceof Error ? err.message : String(err)}`);
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

  const deployLine = resultText
    .split("\n")
    .find((l) => l.startsWith("DEPLOYED:") || l.startsWith("FAILED:"));

  const deployed = deployLine?.startsWith("DEPLOYED:") ?? false;

  const deployment: Deployment = {
    id: randomUUID(),
    environment,
    timestamp: new Date().toISOString(),
    status: deployed ? "deployed" : "failed",
    url: deployed ? deployLine!.replace("DEPLOYED:", "").trim() : undefined,
  };

  const newState: ProjectState = {
    ...state,
    deployments: [...state.deployments, deployment],
  };

  if (deployment.status === "deployed") {
    console.log(`[deploy] Successfully deployed to ${environment}: ${deployment.url ?? "no URL"}`);
    const nextPhase = environment === "staging" ? "ab-testing" : "monitoring";
    return { success: true, nextPhase, state: newState };
  } else {
    console.log(`[deploy] Deployment failed`);
    return { success: false, state: newState, error: "Deployment failed" };
  }
}
