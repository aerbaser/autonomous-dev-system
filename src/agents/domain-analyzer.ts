import { query } from "@anthropic-ai/claude-agent-sdk";
import type { DomainAnalysis, AgentBlueprint } from "../state/project-state.js";

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

IMPORTANT: Only output the JSON, nothing else. Be conservative — only suggest roles that are
genuinely needed for THIS specific project, not generic nice-to-haves.`;

export async function analyzeDomain(idea: string): Promise<DomainAnalysis> {
  let resultText = "";

  for await (const message of query({
    prompt: `${DOMAIN_ANALYSIS_PROMPT}\n\nProject idea: ${idea}`,
    options: {
      allowedTools: ["WebSearch", "WebFetch"],
      maxTurns: 5,
    },
  })) {
    if ("result" in message && typeof message.result === "string") {
      resultText = message.result;
    }
  }

  // Extract JSON from the response
  const jsonMatch = resultText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    // Fallback: generic web app domain
    return {
      classification: "web-application",
      specializations: [],
      requiredRoles: [],
      requiredMcpServers: ["playwright", "github"],
      techStack: ["typescript", "node"],
    };
  }

  try {
    return JSON.parse(jsonMatch[0]) as DomainAnalysis;
  } catch {
    return {
      classification: "web-application",
      specializations: [],
      requiredRoles: [],
      requiredMcpServers: ["playwright", "github"],
      techStack: ["typescript", "node"],
    };
  }
}

const AGENT_GENERATION_PROMPT = `You are an Agent Factory. Given a domain analysis, generate specialized
agent blueprints for each required role.

For EACH role, output a JSON object:
{
  "name": "kebab-case-name",
  "role": "Human-readable role title",
  "systemPrompt": "Detailed system prompt (2-4 paragraphs) explaining the agent's expertise, responsibilities, and output format",
  "tools": ["list", "of", "tools"],
  "evaluationCriteria": ["how to measure this agent's quality"]
}

Available tools: Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, Agent, AskUserQuestion

Output a JSON array of agent blueprints. Only output the JSON array.`;

export async function generateDomainAgents(
  idea: string,
  domain: DomainAnalysis
): Promise<AgentBlueprint[]> {
  if (domain.requiredRoles.length === 0) return [];

  let resultText = "";

  for await (const message of query({
    prompt: `${AGENT_GENERATION_PROMPT}

Project idea: ${idea}
Domain: ${JSON.stringify(domain, null, 2)}

Generate blueprints for these roles: ${domain.requiredRoles.join(", ")}`,
    options: {
      allowedTools: ["WebSearch", "WebFetch"],
      maxTurns: 5,
    },
  })) {
    if ("result" in message && typeof message.result === "string") {
      resultText = message.result;
    }
  }

  const jsonMatch = resultText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const raw = JSON.parse(jsonMatch[0]) as Array<{
      name: string;
      role: string;
      systemPrompt: string;
      tools: string[];
      evaluationCriteria: string[];
    }>;

    return raw.map((r) => ({
      ...r,
      version: 1,
      model: undefined,
      mcpServers: undefined,
    }));
  } catch {
    return [];
  }
}
