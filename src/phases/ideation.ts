import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../utils/config.js";
import type { ProjectState, ProductSpec } from "../state/project-state.js";
import type { PhaseResult } from "../orchestrator.js";
import { analyzeDomain } from "../agents/domain-analyzer.js";
import { consumeQuery } from "../utils/sdk-helpers.js";

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
  const domainPromise = analyzeDomain(state.idea);

  // Step 2: Generate spec
  let specText: string;
  try {
    const { result } = await consumeQuery(
      query({
        prompt: `${SPEC_PROMPT}\n\nProject idea: ${state.idea}`,
        options: {
          tools: ["WebSearch", "WebFetch"],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: 10,
        },
      }),
      "ideation"
    );
    specText = result;
  } catch (err) {
    return {
      success: false,
      state,
      error: `Failed to generate spec: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Parse spec
  const jsonMatch = specText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      success: false,
      state,
      error: "Failed to generate spec: no JSON in output",
    };
  }

  let specData: Omit<ProductSpec, "domain">;
  try {
    specData = JSON.parse(jsonMatch[0]);
  } catch (e) {
    return {
      success: false,
      state,
      error: `Failed to parse spec JSON: ${e}`,
    };
  }

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
    currentPhase: "specification",
  };

  return {
    success: true,
    nextPhase: "architecture",
    state: newState,
  };
}
