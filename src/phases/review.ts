import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../utils/config.js";
import type { ProjectState } from "../state/project-state.js";
import type { PhaseResult, PhaseExecutionContext } from "./types.js";
import { consumeQuery, getQueryPermissions, getMaxTurns, QueryAbortedError } from "../utils/sdk-helpers.js";
import { errMsg, extractFirstJson } from "../utils/shared.js";
import { ReviewResultSchema } from "../types/llm-schemas.js";
import { runLeadDrivenPhase } from "../orchestrator/lead-driven-phase.js";
import { reviewContract } from "../orchestrator/phase-contracts/review.contract.js";

export async function runReview(
  state: ProjectState,
  config: Config,
  ctx?: PhaseExecutionContext
): Promise<PhaseResult> {
  console.log("[review] Running code review...");
  const signal = ctx?.signal;

  // v1.1 super-lead path — opt-in via AUTONOMOUS_DEV_LEAD_DRIVEN=1. When
  // enabled, the lead delegates to security-auditor + accessibility-auditor.
  // When disabled, the single-query path below runs unchanged.
  if (process.env["AUTONOMOUS_DEV_LEAD_DRIVEN"] === "1") {
    console.log("[review] lead-driven mode enabled — spawning audit team");
    const leadResult = await runLeadDrivenPhase({
      contract: reviewContract,
      state,
      config,
      ...(ctx ? { execCtx: ctx } : {}),
      // review's applyResult leaves state unchanged — the verdict lives in
      // PhaseResult.nextPhase, which the orchestrator uses to route.
      applyResult: (s) => s,
    });
    // Default transition if the lead forgot to set nextPhase: approved →
    // staging, requested_changes → development. We peek at the envelope's
    // success + domain intent via the recorded phaseAttempts entry.
    if (leadResult.success && !leadResult.nextPhase) {
      return { ...leadResult, nextPhase: "staging" };
    }
    return leadResult;
  }

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
      { label: "review", ...(signal ? { signal } : {}) }
    );
    resultText = queryResult.result;
    structuredOutput = queryResult.structuredOutput;
    costUsd = queryResult.cost;
  } catch (err) {
    if (err instanceof QueryAbortedError) {
      return { success: false, state, error: "aborted" };
    }
    console.error(`[review] Query failed: ${errMsg(err)}`);
    return { success: false, state, error: errMsg(err) };
  }

  // Prefer native structured output, fall back to JSON extracted from the text
  // body. Only drop to the text heuristic when both fail — and warn because
  // the text path can mis-classify ambiguous outputs.
  let approved: boolean;
  let parsed = structuredOutput != null ? ReviewResultSchema.safeParse(structuredOutput) : null;
  if (!parsed?.success) {
    const jsonStr = extractFirstJson(resultText);
    if (jsonStr) {
      try {
        parsed = ReviewResultSchema.safeParse(JSON.parse(jsonStr));
      } catch {
        parsed = null;
      }
    }
  }

  if (parsed?.success) {
    approved = parsed.data.status === "approved";
    if (!approved && parsed.data.summary) {
      console.log(`[review] Issues: ${parsed.data.summary}`);
    }
  } else {
    console.warn("[review] text fallback used — no structured JSON found in output");
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
