import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../utils/config.js";
import type { ProjectState, ProductSpec, DomainAnalysis } from "../state/project-state.js";
import type { PhaseResult, PhaseExecutionContext } from "./types.js";
import { analyzeDomain } from "../agents/domain-analyzer.js";
import { consumeQuery, getQueryPermissions, getMaxTurns, QueryAbortedError } from "../utils/sdk-helpers.js";
import { extractFirstJson, errMsg, wrapUserInput } from "../utils/shared.js";
import { ProductSpecWithoutDomainSchema, ProductSpecSchema } from "../types/llm-schemas.js";

const SPEC_PROMPT = `You are a Senior Product Manager creating a complete, investor-ready product specification.

Use WebSearch to research the market — find real competitors and industry benchmarks before writing.

Output a JSON object with this exact structure:

{
  "summary": "2-3 sentence product vision that articulates the core value proposition",
  "targetAudience": {
    "primaryPersona": "Detailed description of the main user persona (role, pain points, tech-savviness)",
    "secondaryPersonas": ["Other user types who will benefit from the product"],
    "marketSize": "Estimated addressable market size"
  },
  "competitiveAnalysis": {
    "directCompetitors": [
      {
        "name": "Real competitor name",
        "strengths": ["what they do well"],
        "weaknesses": ["where they fall short"],
        "differentiator": "How our product beats them here"
      }
    ],
    "ourEdge": "The single key differentiator that makes this product win"
  },
  "mvpScope": {
    "included": ["Core features in MVP — smallest set that delivers real value"],
    "excluded": ["Explicitly deferred to v2+"],
    "successMetrics": ["Measurable KPIs for MVP success (e.g., 100 DAU, <2s p95 latency, NPS > 40)"]
  },
  "techStackRecommendation": {
    "rationale": "Why this stack is right for this domain and scale",
    "recommended": ["TypeScript", "Next.js 15", "PostgreSQL", "..."],
    "alternatives": ["Alternative options with trade-offs"]
  },
  "userStories": [
    {
      "id": "US-001",
      "title": "Short imperative title",
      "description": "As a [persona], I want [feature], so that [benefit]",
      "acceptanceCriteria": ["Given X, When Y, Then Z"],
      "priority": "must|should|could|wont"
    }
  ],
  "nonFunctionalRequirements": [
    "Performance: p95 response time under 200ms for API calls",
    "Security: OWASP Top 10 mitigated, HTTPS everywhere",
    "Scalability: handle 10k concurrent users without degradation",
    "Observability: structured logs, metrics, distributed tracing"
  ]
}

Requirements:
- Research 2-3 real competitors via WebSearch before filling competitiveAnalysis
- At least 5 user stories for a simple project, 10+ for complex
- Every user story MUST have at least 2 acceptance criteria in Given/When/Then format
- At least 4 non-functional requirements covering performance, security, scalability, observability
- MVP scope must be realistic for a 2-4 week build; aggressively cut scope
- Use MoSCoW: at least 2 "must" stories, mix of "should"/"could", be honest about "wont"

Think through your analysis step by step, then provide your final answer as a JSON object.`;

const DEFAULT_DOMAIN: DomainAnalysis = {
  classification: "web-application",
  specializations: [],
  requiredRoles: [],
  requiredMcpServers: ["playwright", "github"],
  techStack: ["typescript", "node"],
};

export async function runIdeation(
  state: ProjectState,
  config: Config,
  ctx?: PhaseExecutionContext
): Promise<PhaseResult> {
  console.log("[ideation] Generating product specification...");
  const signal = ctx?.signal;

  // Run domain analysis and spec generation concurrently and await BOTH via
  // Promise.allSettled so neither result is silently dropped. Domain failures
  // degrade gracefully (warn + fall back to DEFAULT_DOMAIN); spec failures
  // fail the phase.
  const domainPromise = analyzeDomain(state.idea, config, signal);

  // The long, fully-static SPEC_PROMPT goes into `options.systemPrompt` so
  // the SDK's ephemeral cache can hit across retries (rubric loop, failures,
  // etc.). The per-call prompt carries only the project-specific idea.
  const specPromise = consumeQuery(
    query({
      prompt: wrapUserInput("project-idea", state.idea),
      options: {
        systemPrompt: SPEC_PROMPT,
        tools: ["WebSearch", "WebFetch"],
        ...getQueryPermissions(config),
        maxTurns: getMaxTurns(config, "ideation"),
      },
    }),
    { label: "ideation", ...(signal ? { signal } : {}) }
  );

  const [domainSettled, specSettled] = await Promise.allSettled([
    domainPromise,
    specPromise,
  ]);

  // Spec failure is fatal for the phase.
  if (specSettled.status === "rejected") {
    const err = specSettled.reason;
    if (err instanceof QueryAbortedError) {
      return { success: false, state, error: "aborted" };
    }
    return {
      success: false,
      state,
      error: `Failed to generate spec: ${errMsg(err)}`,
    };
  }
  const specText = specSettled.value.result;
  const costUsd = specSettled.value.cost;

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

  // Domain failures are non-fatal — warn and continue with the default domain
  // so the successfully-generated spec can still be used.
  let domain: DomainAnalysis;
  if (domainSettled.status === "fulfilled") {
    domain = domainSettled.value;
  } else {
    const err = domainSettled.reason;
    if (err instanceof QueryAbortedError) {
      // Abort affects both queries; treat the phase as aborted so partial
      // state isn't committed.
      return { success: false, state, error: "aborted" };
    }
    console.warn(
      `[ideation] Domain analysis failed, continuing with default domain: ${errMsg(err)}`
    );
    domain = DEFAULT_DOMAIN;
  }

  const spec = ProductSpecSchema.parse({ ...specData, domain });

  console.log(`[ideation] Spec generated: ${spec.userStories.length} user stories`);
  console.log(`[ideation] Domain: ${domain.classification}`);
  console.log(`[ideation] Specializations: ${domain.specializations.join(", ") || "none"}`);
  if (spec.targetAudience) {
    console.log(`[ideation] Target audience: ${spec.targetAudience.primaryPersona.slice(0, 80)}...`);
  }
  if (spec.competitiveAnalysis) {
    const competitors = spec.competitiveAnalysis.directCompetitors.map((c) => c.name).join(", ");
    console.log(`[ideation] Competitors analyzed: ${competitors}`);
    console.log(`[ideation] Our edge: ${spec.competitiveAnalysis.ourEdge.slice(0, 100)}`);
  }
  if (spec.mvpScope) {
    console.log(`[ideation] MVP: ${spec.mvpScope.included.length} features in, ${spec.mvpScope.excluded.length} deferred`);
  }

  // ProductSpec uses exactOptionalPropertyTypes; Zod infers `T | undefined` for optional
  // fields which is structurally incompatible. Runtime shape is fully validated above.
  const newState: ProjectState = {
    ...state,
    spec: spec as ProductSpec,
  };

  return {
    success: true,
    nextPhase: "specification",
    state: newState,
    ...(costUsd != null ? { costUsd } : {}),
  };
}
