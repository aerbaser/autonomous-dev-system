import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../utils/config.js";
import type { ProjectState } from "../state/project-state.js";
import type { PhaseResult } from "../orchestrator.js";
import { getMcpServerConfigs } from "../environment/mcp-manager.js";

export async function runTesting(
  state: ProjectState,
  config: Config
): Promise<PhaseResult> {
  if (!state.spec) {
    return { success: false, state, error: "Spec required for testing" };
  }

  const mcpServers = state.environment
    ? getMcpServerConfigs(state.environment.mcpServers)
    : {};

  console.log("[testing] Running comprehensive test suite...");

  const prompt = `You are a senior QA Engineer. Run the complete test suite and report results.

Steps:
1. Run unit tests: npm test (or the project's test command)
2. Run linter: npm run lint (if configured)
3. Run type-check: npm run typecheck (if TypeScript)
4. If Playwright MCP is available, run E2E tests on critical flows
5. Check test coverage

Acceptance criteria to verify:
${state.spec.userStories.map((us) => `${us.title}:\n${us.acceptanceCriteria.map((ac) => `  - ${ac}`).join("\n")}`).join("\n\n")}

Report:
- Total tests: pass/fail/skip
- Coverage %
- Any failing tests with details
- Recommendation: PASS (proceed to review) or FAIL (back to development with specific issues)

Output ONLY "PASS" or "FAIL: <reasons>" on the final line.`;

  let resultText = "";
  for await (const message of query({
    prompt,
    options: {
      allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      mcpServers,
    },
  })) {
    if ("result" in message && typeof message.result === "string") {
      resultText = message.result;
    }
  }

  const lastLine = resultText.trim().split("\n").pop()?.trim() ?? "";
  const passed = lastLine.startsWith("PASS");

  if (passed) {
    console.log("[testing] All tests PASSED");
    return { success: true, nextPhase: "review", state };
  } else {
    console.log(`[testing] Tests FAILED: ${lastLine}`);
    return { success: true, nextPhase: "development", state };
  }
}
