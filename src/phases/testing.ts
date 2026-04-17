import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../utils/config.js";
import type { ProjectState } from "../state/project-state.js";
import type { PhaseResult } from "./types.js";
import { getMcpServerConfigs } from "../environment/mcp-manager.js";
import { consumeQuery, getQueryPermissions, getMaxTurns } from "../utils/sdk-helpers.js";
import { errMsg, extractFirstJson } from "../utils/shared.js";
import { TestingResultSchema } from "../types/llm-schemas.js";

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

After completing all steps, output your final assessment as JSON:
{"status": "passed"} or {"status": "failed", "details": "<failure reasons>"}

Also output "PASS" or "FAIL: <reasons>" on the final line as a fallback.`;

  let resultText: string;
  let structuredOutput: unknown;
  let costUsd: number | undefined;
  try {
    const queryResult = await consumeQuery(
      query({
        prompt,
        options: {
          tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
          ...getQueryPermissions(config),
          maxTurns: getMaxTurns(config, "testing"),
          mcpServers,
        },
      }),
      "testing"
    );
    resultText = queryResult.result;
    structuredOutput = queryResult.structuredOutput;
    costUsd = queryResult.cost;
  } catch (err) {
    console.error(`[testing] Query failed: ${errMsg(err)}`);
    return { success: false, state, error: errMsg(err) };
  }

  // Prefer native structured output from the SDK. If missing, try to extract
  // JSON from the text body. Only fall back to text heuristic when both fail —
  // and warn loudly when we do, because the text path is fragile.
  let passed: boolean;
  let parsed = structuredOutput != null ? TestingResultSchema.safeParse(structuredOutput) : null;
  if (!parsed?.success) {
    const jsonStr = extractFirstJson(resultText);
    if (jsonStr) {
      try {
        parsed = TestingResultSchema.safeParse(JSON.parse(jsonStr));
      } catch {
        parsed = null;
      }
    }
  }

  if (parsed?.success) {
    passed = parsed.data.status === "passed";
    if (!passed && parsed.data.details) {
      console.log(`[testing] Details: ${parsed.data.details}`);
    }
  } else {
    console.warn("[testing] text fallback used — no structured JSON found in output");
    const lastLine = resultText.trim().split("\n").pop()?.trim() ?? "";
    passed = lastLine.startsWith("PASS");
  }

  if (passed) {
    console.log("[testing] All tests PASSED");
    return { success: true, nextPhase: "review", state, ...(costUsd != null ? { costUsd } : {}) };
  } else {
    console.log("[testing] Tests FAILED");
    return { success: true, nextPhase: "development", state, ...(costUsd != null ? { costUsd } : {}) };
  }
}
