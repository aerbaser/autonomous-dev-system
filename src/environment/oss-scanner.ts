import { query } from "@anthropic-ai/claude-agent-sdk";
import type { OssTool, DomainAnalysis, ArchDesign } from "../state/project-state.js";
import { OssToolArraySchema } from "../types/llm-schemas.js";
import { getQueryPermissions, getMaxTurns } from "../utils/sdk-helpers.js";
import { wrapUserInput, errMsg } from "../utils/shared.js";
import type { Config } from "../utils/config.js";
import { isValidOssType } from "../utils/type-guards.js";

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
  domain: DomainAnalysis,
  config?: Config
): Promise<OssTool[]> {
  const techList = Object.entries(architecture.techStack)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");

  let resultText = "";
  for await (const message of query({
    prompt: `${SCAN_PROMPT}

${wrapUserInput("tech-context", `Tech Stack: ${techList}\nDomain: ${domain.classification}\nSpecializations: ${domain.specializations.join(", ")}`)}`,
    options: {
      allowedTools: ["WebSearch", "WebFetch"],
      ...getQueryPermissions(config),
      maxTurns: getMaxTurns(config, "ossScan"),
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
    if (!parseResult.success) {
      // Strict-at-LLM-boundary: surface the invalid shape so it isn't silently
      // coerced. Caller runs under Promise.allSettled so logging is the right
      // level of severity for a non-critical scan.
      const issues = parseResult.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      console.warn(`[oss-scanner] OSS scan result failed schema validation: ${issues}`);
      return [];
    }

    return parseResult.data.map((o) => ({
      name: o.name,
      repo: o.repo,
      type: isValidOssType(o.type) ? o.type : "pattern",
      integrationPlan: o.integrationPlan,
      integrated: false,
    }));
  } catch (err) {
    console.warn(`[oss-scanner] OSS scan JSON parse failed: ${errMsg(err)}`);
    return [];
  }
}
