import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../utils/config.js";
import type { ProjectState, ProductSpec, DomainAnalysis } from "../state/project-state.js";
import type { PhaseExecutionContext, PhaseResult } from "./types.js";
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

const SPEC_REPAIR_PROMPT = `You are repairing a previously generated product specification so it matches the required JSON contract.

Return ONLY a JSON object with this exact structure:
{
  "summary": "2-3 sentence product vision",
  "targetAudience": {
    "primaryPersona": "Primary user persona",
    "secondaryPersonas": ["Other user types"],
    "marketSize": "Estimated addressable market size"
  },
  "competitiveAnalysis": {
    "directCompetitors": [
      {
        "name": "Real competitor name",
        "strengths": ["what they do well"],
        "weaknesses": ["where they fall short"],
        "differentiator": "How our product beats them"
      }
    ],
    "ourEdge": "Main differentiator"
  },
  "mvpScope": {
    "included": ["Core MVP features"],
    "excluded": ["Deferred items"],
    "successMetrics": ["Measurable KPIs"]
  },
  "techStackRecommendation": {
    "rationale": "Why this stack fits",
    "recommended": ["TypeScript", "Node.js"],
    "alternatives": ["Viable alternatives"]
  },
  "userStories": [
    {
      "id": "US-001",
      "title": "Short title",
      "description": "As a [persona], I want [feature], so that [benefit]",
      "acceptanceCriteria": ["Given X, When Y, Then Z"],
      "priority": "must|should|could|wont"
    }
  ],
  "nonFunctionalRequirements": ["Performance requirement", "Security requirement"]
}

Rules:
- Preserve the original meaning; only fix structure and formatting
- Return valid JSON only, with no markdown fences or commentary
- userStories must be a non-empty array
- nonFunctionalRequirements must be a non-empty array`;

function parseSpecText(specText: string): {
  parsed?: ReturnType<typeof ProductSpecWithoutDomainSchema.parse>;
  error?: string;
} {
  const jsonStr = extractFirstJson(specText);
  if (!jsonStr) {
    return { error: "no valid JSON in output" };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(jsonStr);
  } catch {
    return { error: "no valid JSON in output" };
  }

  const parseResult = ProductSpecWithoutDomainSchema.safeParse(parsedJson);
  if (!parseResult.success) {
    return { error: parseResult.error.message };
  }

  if (parseResult.data.userStories.length === 0) {
    return { error: "userStories must not be empty" };
  }
  if (parseResult.data.nonFunctionalRequirements.length === 0) {
    return { error: "nonFunctionalRequirements must not be empty" };
  }

  return { parsed: parseResult.data };
}

async function repairSpecText(
  specText: string,
  parseError: string,
  state: ProjectState,
  config: Config,
  ctx?: PhaseExecutionContext,
): Promise<{ repairedText: string; costUsd?: number; sessionId?: string }> {
  const repairResult = await consumeQuery(
    query({
      prompt: `${SPEC_REPAIR_PROMPT}

Validation error: ${parseError}

${wrapUserInput("project-idea", state.idea)}

${wrapUserInput("broken-product-spec", specText)}`,
      options: {
        allowedTools: [],
        ...getQueryPermissions(config),
        maxTurns: 1,
      },
    }),
    {
      label: "ideation-repair",
      eventBus: ctx?.eventBus,
      phase: "ideation",
      agentName: "spec-repair",
      model: config.model,
    }
  );

  return {
    repairedText: repairResult.result,
    ...(repairResult.cost != null ? { costUsd: repairResult.cost } : {}),
    ...(repairResult.sessionId ? { sessionId: repairResult.sessionId } : {}),
  };
}

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
  ctx?: PhaseExecutionContext,
): Promise<PhaseResult> {
  console.log("[ideation] Generating product specification...");
  const signal = ctx?.signal;

  // Run domain analysis and spec generation concurrently and await BOTH via
  // Promise.allSettled so neither result is silently dropped. Domain failures
  // degrade gracefully (warn + fall back to DEFAULT_DOMAIN); spec failures
  // fail the phase.
  const domainPromise = analyzeDomain(state.idea, config, {
    eventBus: ctx?.eventBus,
    phase: "ideation",
    model: config.model,
    ...(signal ? { signal } : {}),
  });

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
    {
      label: "ideation",
      eventBus: ctx?.eventBus,
      phase: "ideation",
      agentName: "spec-writer",
      model: config.model,
      ...(signal ? { signal } : {}),
    }
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
  let specText = specSettled.value.result;
  let costUsd: number | undefined = specSettled.value.cost;
  let sessionId: string | undefined = specSettled.value.sessionId;

  let specParseResult = parseSpecText(specText);
  if (!specParseResult.parsed) {
    console.warn(`[ideation] Primary parse failed, attempting repair: ${specParseResult.error}`);
    try {
      const repairResult = await repairSpecText(
        specText,
        specParseResult.error ?? "unknown parse error",
        state,
        config,
        ctx,
      );
      specText = repairResult.repairedText;
      if (repairResult.costUsd != null) {
        costUsd = (costUsd ?? 0) + repairResult.costUsd;
      }
      if (!sessionId && repairResult.sessionId) {
        sessionId = repairResult.sessionId;
      }
      specParseResult = parseSpecText(specText);
    } catch (err) {
      return {
        success: false,
        state,
        error: `Invalid spec JSON: ${specParseResult.error}. Repair failed: ${errMsg(err)}`,
      };
    }
  }
  if (!specParseResult.parsed) {
    return {
      success: false,
      state,
      error: `Invalid spec JSON: ${specParseResult.error}`,
    };
  }
  const specData = specParseResult.parsed;

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
    ...(sessionId ? { sessionId } : {}),
  };
}
