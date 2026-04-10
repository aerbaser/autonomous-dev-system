import { query } from "@anthropic-ai/claude-agent-sdk";
import type { DomainAnalysis, AgentBlueprint } from "../state/project-state.js";
import { consumeQuery, getQueryPermissions, getMaxTurns } from "../utils/sdk-helpers.js";
import type { Config } from "../utils/config.js";
import { DomainAnalysisSchema, DomainAgentArraySchema } from "../types/llm-schemas.js";
import { extractFirstJson, wrapUserInput } from "../utils/shared.js";
import type { EventBus } from "../events/event-bus.js";
import type { Phase } from "../state/project-state.js";

const DOMAIN_ANALYSIS_PROMPT = `You are a Domain Analyzer. Given a project idea, analyze what domain expertise
and specialized roles are needed beyond the standard development team (PM, Dev, QA, DevOps, Reviewer).

Think carefully and specifically about THIS project:
- What specialized domain knowledge is essential (e.g., financial math, HIPAA compliance, ML model training)?
- What algorithms, data structures, or numerical methods are core to the product?
- What regulatory, compliance, or security requirements apply to this domain?
- What specialized testing is needed (e.g., load testing for trading systems, clinical validation for health apps)?
- What domain-specific integrations are likely needed (payment processors, EHR systems, social APIs)?

Domain classification examples:
- "fintech/payments" — money movement, fraud detection, PCI-DSS
- "healthcare/clinical" — patient data, HIPAA, FDA regulations
- "data-science/ml" — model training, feature engineering, experiment tracking
- "devtools/cli" — developer experience, cross-platform, package distribution
- "realtime/collaborative" — WebSockets, CRDT, conflict resolution
- "ecommerce/marketplace" — inventory, payments, fulfillment
- "web-application" — general SaaS with no heavy domain specialization

Think through the domain analysis step by step, then provide your final answer as a JSON object:
{
  "classification": "specific domain label from examples above or a new precise one",
  "specializations": ["specific knowledge areas THIS project needs, not generic ones"],
  "requiredRoles": ["specialized agent roles beyond standard — only what THIS project genuinely needs"],
  "requiredMcpServers": ["MCP servers that give direct value for this domain, e.g. playwright for web, github for devtools"],
  "techStack": ["domain-appropriate technologies with version hints, e.g. 'PostgreSQL 16 with pgvector for ML embeddings'"]
}

Be conservative: only add a role if it would change the implementation in a meaningful way.`;

interface DomainQueryTelemetryOptions {
  eventBus?: EventBus | undefined;
  phase?: Phase | undefined;
  model?: string | undefined;
}

export async function analyzeDomain(
  idea: string,
  config?: Config,
  telemetry?: DomainQueryTelemetryOptions,
): Promise<DomainAnalysis> {
  let resultText: string;

  try {
    const { result } = await consumeQuery(
      query({
        prompt: `${DOMAIN_ANALYSIS_PROMPT}\n\n${wrapUserInput("project-idea", idea)}`,
        options: {
          tools: ["WebSearch", "WebFetch"],
          ...getQueryPermissions(config),
          maxTurns: getMaxTurns(config, "domainAnalysis"),
        },
      }),
      {
        label: "domain-analysis",
        eventBus: telemetry?.eventBus,
        phase: telemetry?.phase,
        agentName: "domain-analyzer",
        model: telemetry?.model,
      }
    );
    resultText = result;
  } catch (err) {
    console.warn(`[domain-analyzer] Query failed: ${err instanceof Error ? err.message : String(err)}`);
    return getDefaultDomain();
  }

  // Extract JSON from the response
  const jsonStr = extractFirstJson(resultText);
  if (!jsonStr) {
    return getDefaultDomain();
  }

  try {
    const parseResult = DomainAnalysisSchema.safeParse(JSON.parse(jsonStr));
    return parseResult.success ? parseResult.data : getDefaultDomain();
  } catch {
    return getDefaultDomain();
  }
}

const AGENT_GENERATION_PROMPT = `You are an Agent Factory. Given a domain analysis and project idea, generate specialized
agent blueprints tailored to THIS specific project.

For each role, think deeply about what makes this role domain-specific vs generic:
1. What unique domain expertise (algorithms, regulations, standards) does this role apply?
2. What concrete deliverables does this agent produce that a generic dev agent cannot?
3. What tools does this agent actually need for ITS tasks?
4. What specific, testable criteria show this agent did excellent work?

## Rules for excellent agent blueprints

systemPrompt must:
- Open with "You are a [specific title] specializing in [specific domain area of THIS project]"
- Name the concrete technologies, standards, or algorithms relevant to THIS project
- List 4-6 specific responsibilities (not generic "write code" but "implement JWT rotation with Redis blocklist")
- State hard constraints unique to this domain (e.g., "never use floating-point for money amounts")
- Describe the expected output format (JSON schema, file type, etc.)

evaluationCriteria must be:
- Specific to this agent's domain (not "code is clean" but "all SQL queries use parameterized statements")
- Objectively verifiable by reading the output
- At least 3 criteria, ideally 4-5

## Example (fintech project):

{
  "name": "payments-specialist",
  "role": "Payment Integration Specialist",
  "systemPrompt": "You are a Payment Integration Specialist for a fintech lending platform.\\n\\nYour expertise covers:\\n- Stripe Connect for marketplace payments and escrow\\n- ACH transfer timing, reversal windows, and NACHA compliance\\n- PCI-DSS scope reduction via Stripe.js tokenization (no raw card data server-side)\\n- Idempotent payment operations to prevent double-charges\\n\\nResponsibilities:\\n- Implement payment flows: charge, refund, dispute handling\\n- Build webhook handlers with signature verification and at-least-once delivery\\n- Write reconciliation logic comparing Stripe ledger vs internal DB\\n- Ensure all monetary values use integer cents (never floats)\\n\\nConstraints:\\n- Every payment mutation must be idempotent (idempotency-key header)\\n- No raw card data may touch the server — use Stripe.js or Payment Element\\n- All webhook handlers must verify Stripe-Signature before processing\\n\\nOutput: TypeScript with strict types, Zod validation on webhook payloads, integration tests using Stripe test mode keys.",
  "tools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch"],
  "evaluationCriteria": [
    "All monetary values stored and computed as integer cents, no floating-point arithmetic",
    "Webhook handlers verify Stripe-Signature before processing any payload",
    "Payment mutations include idempotency keys to prevent double-charges",
    "Reconciliation logic handles Stripe clock drift and delayed webhook delivery",
    "Integration tests cover happy path, payment failure, and refund scenarios using Stripe test mode"
  ]
}

Available tools: Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, Agent, AskUserQuestion

Think through what each agent role needs for this specific domain, then provide your final answer as a JSON array of agent blueprints.`;

export async function generateDomainAgents(
  idea: string,
  domain: DomainAnalysis,
  config?: Config,
  telemetry?: DomainQueryTelemetryOptions,
): Promise<AgentBlueprint[]> {
  if (domain.requiredRoles.length === 0) return [];

  let resultText: string;

  try {
    const { result } = await consumeQuery(
      query({
        prompt: `${AGENT_GENERATION_PROMPT}

${wrapUserInput("project-idea", idea)}

${wrapUserInput("domain-analysis", JSON.stringify(domain, null, 2))}

Generate blueprints for these roles: ${domain.requiredRoles.join(", ")}`,
        options: {
          tools: ["WebSearch", "WebFetch"],
          ...getQueryPermissions(config),
          maxTurns: getMaxTurns(config, "domainAnalysis"),
        },
      }),
      {
        label: "agent-generation",
        eventBus: telemetry?.eventBus,
        phase: telemetry?.phase,
        agentName: "agent-generator",
        model: telemetry?.model,
      }
    );
    resultText = result;
  } catch {
    return [];
  }

  const jsonMatch = resultText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const parseResult = DomainAgentArraySchema.safeParse(JSON.parse(jsonMatch[0]));
    if (!parseResult.success) return [];
    const raw = parseResult.data;

    return raw.map((r) => ({
      ...r,
      evaluationCriteria: r.evaluationCriteria.length >= 3
        ? r.evaluationCriteria
        : [
            ...r.evaluationCriteria,
            ...Array.from(
              { length: 3 - r.evaluationCriteria.length },
              (_, i) => `Agent output meets domain quality standard #${i + 1}`
            ),
          ],
      version: 1,
    }));
  } catch {
    return [];
  }
}

function getDefaultDomain(): DomainAnalysis {
  return {
    classification: "web-application",
    specializations: [],
    requiredRoles: [],
    requiredMcpServers: ["playwright", "github"],
    techStack: ["typescript", "node"],
  };
}
