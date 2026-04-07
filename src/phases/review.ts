import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../utils/config.js";
import type { ProjectState } from "../state/project-state.js";
import type { PhaseResult } from "../orchestrator.js";

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

  let resultText = "";
  for await (const message of query({
    prompt,
    options: {
      allowedTools: ["Read", "Glob", "Grep"],
    },
  })) {
    if ("result" in message && typeof message.result === "string") {
      resultText = message.result;
    }
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
