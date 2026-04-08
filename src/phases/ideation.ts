import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../utils/config.js";
import type { ProjectState, ProductSpec } from "../state/project-state.js";
import type { PhaseResult } from "./types.js";
import { analyzeDomain } from "../agents/domain-analyzer.js";
import { consumeQuery, getQueryPermissions, getMaxTurns } from "../utils/sdk-helpers.js";
import { extractFirstJson, errMsg, wrapUserInput } from "../utils/shared.js";
import { ProductSpecWithoutDomainSchema } from "../types/llm-schemas.js";

const SPEC_PROMPT = `You are a Product Manager creating a complete product specification.

Given this project idea, produce a comprehensive spec in JSON format:

{
  "summary": "2-3 sentence product vision",
  "userStories": [
    {
      "id": "US-001",
      "title": "Short title",
      "description": "As a [user], I want [feature], so that [benefit]",
      "acceptanceCriteria": ["Given X, When Y, Then Z", ...],
      "priority": "must|should|could|wont"
    }
  ],
  "nonFunctionalRequirements": [
    "Performance: page load under 2s",
    "Security: OWASP top 10 compliance",
    ...
  ]
}

Requirements:
- At least 5 user stories for a simple project, 10+ for complex
- Every user story MUST have acceptance criteria in Given/When/Then format
- Include at least 3 non-functional requirements
- Use MoSCoW prioritization: at least 2 "must", some "should" and "could"
- Be specific and actionable

Output ONLY the JSON, nothing else.`;

export async function runIdeation(
  state: ProjectState,
  config: Config
): Promise<PhaseResult> {
  console.log("[ideation] Generating product specification...");

  // Step 1: Domain analysis (parallel with spec generation)
  const domainPromise = analyzeDomain(state.idea, config);

  // Step 2: Generate spec
  let specText: string;
  let costUsd: number | undefined;
  try {
    const queryResult = await consumeQuery(
      query({
        prompt: `${SPEC_PROMPT}\n\n${wrapUserInput("project-idea", state.idea)}`,
        options: {
          tools: ["WebSearch", "WebFetch"],
          ...getQueryPermissions(config),
          maxTurns: getMaxTurns(config, "ideation"),
        },
      }),
      "ideation"
    );
    specText = queryResult.result;
    costUsd = queryResult.cost;
  } catch (err) {
    return {
      success: false,
      state,
      error: `Failed to generate spec: ${errMsg(err)}`,
    };
  }

  // Parse spec
  const jsonStr = extractFirstJson(specText);
  if (!jsonStr) {
    return {
      success: false,
      state,
      error: "Failed to generate spec: no valid JSON in output",
    };
  }

  const parseResult = ProductSpecWithoutDomainSchema.safeParse(JSON.parse(jsonStr));
  if (!parseResult.success) {
    return {
      success: false,
      state,
      error: `Invalid spec JSON: ${parseResult.error.message}`,
    };
  }
  const specData = parseResult.data;

  // Step 3: Combine with domain analysis
  const domain = await domainPromise;

  const spec: ProductSpec = {
    ...specData,
    domain,
  };

  console.log(`[ideation] Spec generated: ${spec.userStories.length} user stories`);
  console.log(`[ideation] Domain: ${domain.classification}`);
  console.log(`[ideation] Specializations: ${domain.specializations.join(", ") || "none"}`);

  const newState: ProjectState = {
    ...state,
    spec,
  };

  return {
    success: true,
    nextPhase: "architecture",
    state: newState,
    ...(costUsd != null ? { costUsd } : {}),
  };
}
