import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../utils/config.js";
import type { ProjectState } from "../state/project-state.js";
import type { PhaseResult } from "./types.js";
import { consumeQuery, getQueryPermissions, getMaxTurns } from "../utils/sdk-helpers.js";
import { errMsg } from "../utils/shared.js";
import { ReviewResultSchema } from "../types/llm-schemas.js";

export async function runReview(
  state: ProjectState,
  config: Config
): Promise<PhaseResult> {
  console.log("[review] Running code review...");

  const prompt = `You are a senior Code Reviewer. Review ALL code in this project.

Review on three axes:
1. **Security**: OWASP top 10, injection flaws, auth issues, data exposure, secrets in code
2. **Performance**: N+1 queries, memory leaks, unnecessary computation, large bundles
3. **Quality**: naming, structure, DRY, SOLID, error handling, test coverage

Output a structured review:
- CRITICAL issues (must fix before deploy)
- WARNINGS (should fix)
- SUGGESTIONS (nice to have)
- POSITIVE callouts

After completing the review, output your final decision as JSON:
{"status": "approved"} or {"status": "requested_changes", "summary": "<critical issues>"}

Also end with "APPROVE" or "REQUEST_CHANGES: <summary>" as a fallback.`;

  let resultText: string;
  let structuredOutput: unknown;
  let costUsd: number | undefined;
  try {
    const queryResult = await consumeQuery(
      query({
        prompt,
        options: {
          tools: ["Read", "Glob", "Grep"],
          ...getQueryPermissions(config),
          maxTurns: getMaxTurns(config, "review"),
        },
      }),
      "review"
    );
    resultText = queryResult.result;
    structuredOutput = queryResult.structuredOutput;
    costUsd = queryResult.cost;
  } catch (err) {
    console.error(`[review] Query failed: ${errMsg(err)}`);
    return { success: false, state, error: errMsg(err) };
  }

  let approved: boolean;
  const parsed = structuredOutput != null ? ReviewResultSchema.safeParse(structuredOutput) : null;
  if (parsed?.success) {
    approved = parsed.data.status === "approved";
    if (!approved && parsed.data.summary) {
      console.log(`[review] Issues: ${parsed.data.summary}`);
    }
  } else {
    approved = resultText.includes("APPROVE") && !resultText.includes("REQUEST_CHANGES");
  }

  if (approved) {
    console.log("[review] Code review: APPROVED");
    return { success: true, nextPhase: "staging", state, ...(costUsd != null ? { costUsd } : {}) };
  } else {
    console.log("[review] Code review: CHANGES REQUESTED");
    return { success: true, nextPhase: "development", state, ...(costUsd != null ? { costUsd } : {}) };
  }
}
