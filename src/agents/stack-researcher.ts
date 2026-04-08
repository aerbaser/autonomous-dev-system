import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ArchDesign, DomainAnalysis, StackEnvironment, LspConfig, McpDiscovery, PluginDiscovery, OssTool } from "../state/project-state.js";
import { consumeQuery, getQueryPermissions, getMaxTurns } from "../utils/sdk-helpers.js";
import type { Config } from "../utils/config.js";
import { StackResearchResultSchema } from "../types/llm-schemas.js";

const VALID_SCOPES = ["project", "user"] as const;
type Scope = (typeof VALID_SCOPES)[number];

function isValidScope(value: string): value is Scope {
  return (VALID_SCOPES as readonly string[]).includes(value);
}

const VALID_OSS_TYPES = ["agent", "skill", "hook", "mcp-server", "pattern"] as const;
type OssType = (typeof VALID_OSS_TYPES)[number];

function isValidOssType(value: string): value is OssType {
  return (VALID_OSS_TYPES as readonly string[]).includes(value);
}

const RESEARCH_PROMPT = `You are a Stack Researcher. Given a project's tech stack and domain,
find the best tools to supercharge AI agent development.

Search for:
1. **LSP servers** for each language in the project (Piebald-AI marketplace, npm, PyPI)
2. **MCP servers** relevant to the stack and domain (MCPcat.io, Smithery, npm, GitHub)
3. **Claude Code plugins** with skills for this stack (Claude marketplaces, GitHub)
4. **Open-source tools** that could be reused as agents, skills, or patterns

For each found tool, include:
- Why it helps THIS project specifically
- Install command or configuration
- Confidence level (high/medium/low)

Output a JSON object:
{
  "lspServers": [
    { "language": "typescript", "server": "vtsls", "installCommand": "npm i -g typescript-language-server typescript", "reason": "..." }
  ],
  "mcpServers": [
    { "name": "playwright", "source": "npm:@playwright/mcp@latest", "config": { "command": "npx", "args": ["@playwright/mcp@latest"] }, "reason": "..." }
  ],
  "plugins": [
    { "name": "plugin-name", "source": "marketplace-name", "scope": "project", "reason": "..." }
  ],
  "openSourceTools": [
    { "name": "tool-name", "repo": "https://github.com/...", "type": "agent|skill|hook|mcp-server|pattern", "integrationPlan": "..." }
  ],
  "claudeMdSuggestions": [
    "Convention or instruction to include in CLAUDE.md"
  ]
}

Be conservative: only suggest tools that will genuinely help. Quality over quantity.
Output ONLY the JSON.`;

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

export async function researchStack(
  architecture: ArchDesign,
  domain: DomainAnalysis,
  config?: Config
): Promise<StackEnvironment> {
  const techList = Object.entries(architecture.techStack)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  let resultText: string;

  try {
    const { result } = await consumeQuery(
      query({
        prompt: `${RESEARCH_PROMPT}

Tech Stack:
${techList}

Domain: ${domain.classification}
Specializations: ${domain.specializations.join(", ")}
Recommended MCP servers from domain analysis: ${domain.requiredMcpServers.join(", ")}`,
        options: {
          tools: ["WebSearch", "WebFetch"],
          ...getQueryPermissions(config),
          maxTurns: getMaxTurns(config, "stackResearch"),
        },
      }),
      "stack-research"
    );
    resultText = result;
  } catch {
    return getDefaultEnvironment(architecture, domain);
  }

  const jsonStr = extractFirstJson(resultText);
  if (!jsonStr) {
    return getDefaultEnvironment(architecture, domain);
  }

  try {
    const parseResult = StackResearchResultSchema.safeParse(JSON.parse(jsonStr));
    if (!parseResult.success) return getDefaultEnvironment(architecture, domain);
    const raw = parseResult.data;

    const lspServers: LspConfig[] = (raw.lspServers ?? []).map((l) => ({
      language: l.language,
      server: l.server,
      installCommand: l.installCommand,
      installed: false,
    }));

    const mcpServers: McpDiscovery[] = (raw.mcpServers ?? []).map((m) => ({
      name: m.name,
      source: m.source,
      config: { command: m.config.command, ...(m.config.args ? { args: m.config.args } : {}) },
      installed: false,
      reason: m.reason ?? "",
    }));

    const plugins: PluginDiscovery[] = (raw.plugins ?? []).map((p) => ({
      name: p.name,
      source: p.source,
      scope: (p.scope && isValidScope(p.scope)) ? p.scope : "project",
      installed: false,
      reason: p.reason ?? "",
    }));

    const openSourceTools: OssTool[] = (raw.openSourceTools ?? []).map((o) => ({
      name: o.name,
      repo: o.repo,
      type: isValidOssType(o.type) ? o.type : "pattern",
      integrationPlan: o.integrationPlan,
      integrated: false,
    }));

    const claudeMd = (raw.claudeMdSuggestions ?? []).join("\n");

    return { lspServers, mcpServers, plugins, openSourceTools, claudeMd };
  } catch {
    return getDefaultEnvironment(architecture, domain);
  }
}

function getDefaultEnvironment(
  architecture: ArchDesign,
  domain: DomainAnalysis
): StackEnvironment {
  const lspServers: LspConfig[] = [];
  const stack = Object.values(architecture.techStack).join(" ").toLowerCase();

  if (stack.includes("typescript") || stack.includes("javascript") || stack.includes("node")) {
    lspServers.push({
      language: "typescript",
      server: "vtsls",
      installCommand: "npm install -g @vtsls/language-server typescript",
      installed: false,
    });
  }
  if (stack.includes("python")) {
    lspServers.push({
      language: "python",
      server: "pyright",
      installCommand: "npm install -g pyright",
      installed: false,
    });
  }
  if (stack.includes("rust")) {
    lspServers.push({
      language: "rust",
      server: "rust-analyzer",
      installCommand: "rustup component add rust-analyzer",
      installed: false,
    });
  }
  if (stack.includes("go")) {
    lspServers.push({
      language: "go",
      server: "gopls",
      installCommand: "go install golang.org/x/tools/gopls@latest",
      installed: false,
    });
  }

  const mcpServers: McpDiscovery[] = [
    {
      name: "playwright",
      source: "npm:@playwright/mcp@latest",
      config: { command: "npx", args: ["@playwright/mcp@latest"] },
      installed: false,
      reason: "E2E browser testing for all web projects",
    },
    {
      name: "github",
      source: "npm:@anthropic-ai/mcp-github",
      config: { command: "npx", args: ["@anthropic-ai/mcp-github"] },
      installed: false,
      reason: "GitHub integration for PRs, issues, CI",
    },
  ];

  return {
    lspServers,
    mcpServers,
    plugins: [],
    openSourceTools: [],
    claudeMd: "",
  };
}
