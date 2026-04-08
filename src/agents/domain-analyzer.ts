import { query } from "@anthropic-ai/claude-agent-sdk";
import type { DomainAnalysis, AgentBlueprint } from "../state/project-state.js";
import { consumeQuery, getQueryPermissions, getMaxTurns } from "../utils/sdk-helpers.js";
import type { Config } from "../utils/config.js";
import { DomainAnalysisSchema, DomainAgentArraySchema } from "../types/llm-schemas.js";

const DOMAIN_ANALYSIS_PROMPT = `You are a Domain Analyzer. Given a project idea, analyze what domain expertise
and specialized roles are needed beyond the standard development team (PM, Dev, QA, DevOps, Reviewer).

Think carefully about:
- What domain knowledge is required?
- What specialized calculations, algorithms, or data processing is needed?
- What regulatory or compliance considerations exist?
- What specialized testing approaches are needed?

Output a JSON object with this structure:
{
  "classification": "primary domain (e.g., fintech/trading, healthcare, SaaS, data-science, math-heavy)",
  "specializations": ["list of specialized knowledge areas needed"],
  "requiredRoles": ["list of specialized agent roles beyond standard"],
  "requiredMcpServers": ["list of MCP servers that would be useful"],
  "techStack": ["recommended technologies for this domain"]
}

IMPORTANT: Only output the JSON, nothing else. Be conservative -- only suggest roles that are
genuinely needed for THIS specific project, not generic nice-to-haves.`;

function extractFirstJson(text: string): string | null {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        const candidate = text.slice(start, i + 1);
        try { JSON.parse(candidate); return candidate; } catch { start = -1; }
      }
    }
  }
  return null;
}

export async function analyzeDomain(idea: string, config?: Config): Promise<DomainAnalysis> {
  let resultText: string;

  try {
    const { result } = await consumeQuery(
      query({
        prompt: `${DOMAIN_ANALYSIS_PROMPT}\n\nProject idea: ${idea}`,
        options: {
          tools: ["WebSearch", "WebFetch"],
          ...getQueryPermissions(config),
          maxTurns: getMaxTurns(config, "domainAnalysis"),
        },
      }),
      "domain-analysis"
    );
    resultText = result;
  } catch {
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

const AGENT_GENERATION_PROMPT = `You are an Agent Factory. Given a domain analysis, generate specialized
agent blueprints for each required role.

Think about what domain-specific tasks each role would handle:
1. What unique expertise does this role bring that standard agents lack?
2. What specific deliverables will this agent produce?
3. What tools does this agent need to do its job?
4. How do we measure if this agent did well? (at least 3 evaluation criteria)

## Example of a well-formed domain agent blueprint

{
  "name": "financial-analyst",
  "role": "Financial Data Analyst",
  "systemPrompt": "You are a Financial Data Analyst specializing in market data processing and risk calculations.\\n\\nYour responsibilities:\\n- Design and validate financial calculations (interest rates, amortization, risk scores)\\n- Ensure numerical precision using decimal arithmetic (never floating-point for money)\\n- Validate data pipelines for financial reporting\\n- Implement compliance checks for regulatory requirements (SOX, PCI-DSS)\\n\\nKey constraints:\\n- All monetary values must use integer cents or a Decimal library\\n- Every calculation must have an audit trail\\n- All formulas must be documented with their source (regulatory doc, business rule)\\n\\nOutput format: provide analysis as structured JSON with calculations, assumptions, and validation results.",
  "tools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch"],
  "evaluationCriteria": [
    "All financial calculations use decimal/integer arithmetic, never floating-point",
    "Every formula has a documented source reference",
    "Compliance checks cover all relevant regulations for the jurisdiction",
    "Edge cases handled: zero amounts, negative values, currency conversion rounding"
  ]
}

## Constraints

- Each agent MUST have at least 3 evaluation criteria that are specific and testable
- The systemPrompt must be detailed (2-4 paragraphs) covering expertise, responsibilities, constraints, and output format
- Tools must match what the agent actually needs -- don't give Bash to agents that only analyze text
- The name must be kebab-case and descriptive of the domain role

For EACH role, output a JSON object:
{
  "name": "kebab-case-name",
  "role": "Human-readable role title",
  "systemPrompt": "Detailed system prompt",
  "tools": ["list", "of", "tools"],
  "evaluationCriteria": ["at least 3 specific, testable criteria"]
}

Available tools: Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, Agent, AskUserQuestion

Output a JSON array of agent blueprints. Only output the JSON array.`;

export async function generateDomainAgents(
  idea: string,
  domain: DomainAnalysis,
  config?: Config
): Promise<AgentBlueprint[]> {
  if (domain.requiredRoles.length === 0) return [];

  let resultText: string;

  try {
    const { result } = await consumeQuery(
      query({
        prompt: `${AGENT_GENERATION_PROMPT}

Project idea: ${idea}
Domain: ${JSON.stringify(domain, null, 2)}

Generate blueprints for these roles: ${domain.requiredRoles.join(", ")}`,
        options: {
          tools: ["WebSearch", "WebFetch"],
          ...getQueryPermissions(config),
          maxTurns: getMaxTurns(config, "domainAnalysis"),
        },
      }),
      "agent-generation"
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
