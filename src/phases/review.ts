import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../utils/config.js";
import type { ProjectState } from "../state/project-state.js";
import type { PhaseResult } from "../orchestrator.js";
import { consumeQuery } from "../utils/sdk-helpers.js";

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

End with: "APPROVE" or "REQUEST_CHANGES: <summary of critical issues>"`;

  let resultText: string;
  try {
    const { result } = await consumeQuery(
      query({
        prompt,
        options: {
          tools: ["Read", "Glob", "Grep"],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: 20,
        },
      }),
      "review"
    );
    resultText = result;
  } catch (err) {
    console.error(`[review] Query failed: ${err instanceof Error ? err.message : String(err)}`);
    return { success: false, state, error: err instanceof Error ? err.message : String(err) };
  }

  const approved = resultText.includes("APPROVE") && !resultText.includes("REQUEST_CHANGES");

  if (approved) {
    console.log("[review] Code review: APPROVED");
    return { success: true, nextPhase: "staging", state };
  } else {
    console.log("[review] Code review: CHANGES REQUESTED");
    return { success: true, nextPhase: "development", state };
  }
}
