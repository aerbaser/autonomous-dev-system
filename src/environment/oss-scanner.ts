import { query } from "@anthropic-ai/claude-agent-sdk";
import type { OssTool, DomainAnalysis, ArchDesign } from "../state/project-state.js";
import { OssToolArraySchema } from "../types/llm-schemas.js";

const VALID_OSS_TYPES = ["agent", "skill", "hook", "mcp-server", "pattern"] as const;
type OssType = (typeof VALID_OSS_TYPES)[number];

function isValidOssType(value: string): value is OssType {
  return (VALID_OSS_TYPES as readonly string[]).includes(value);
}

const SCAN_PROMPT = `You are an Open Source Scanner. Search GitHub and the web for
reusable AI agent tools, Claude Code plugins, MCP servers, and patterns
that would help with this specific project.

Focus on:
- Claude Code agent definitions that could be reused
- MCP servers specific to this domain
- Workflow patterns from similar projects
- Specialized tools (backtesting frameworks, data validation, etc.)

For each tool found, output:
{
  "name": "tool-name",
  "repo": "https://github.com/owner/repo",
  "type": "agent|skill|hook|mcp-server|pattern",
  "integrationPlan": "How to integrate this into our system"
}

Only suggest tools that are:
- Actively maintained (last commit < 6 months)
- Have meaningful stars/usage
- Solve a real problem for THIS project

Output a JSON array. If nothing useful found, output [].`;

export async function scanOpenSource(
  architecture: ArchDesign,
  domain: DomainAnalysis
): Promise<OssTool[]> {
  const techList = Object.entries(architecture.techStack)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");

  let resultText = "";
  for await (const message of query({
    prompt: `${SCAN_PROMPT}

Tech Stack: ${techList}
Domain: ${domain.classification}
Specializations: ${domain.specializations.join(", ")}`,
    options: {
      allowedTools: ["WebSearch", "WebFetch"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: 10,
    },
  })) {
    if ("result" in message && typeof message.result === "string") {
      resultText = message.result;
    }
  }

  const jsonMatch = resultText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const parseResult = OssToolArraySchema.safeParse(JSON.parse(jsonMatch[0]));
    if (!parseResult.success) return [];

    return parseResult.data.map((o) => ({
      name: o.name,
      repo: o.repo,
      type: isValidOssType(o.type) ? o.type : "pattern",
      integrationPlan: o.integrationPlan,
      integrated: false,
    }));
  } catch {
    return [];
  }
}
