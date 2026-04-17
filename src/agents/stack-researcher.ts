import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ArchDesign, DomainAnalysis, StackEnvironment, LspConfig, McpDiscovery, PluginDiscovery, OssTool } from "../state/project-state.js";
import { consumeQuery, getQueryPermissions, getMaxTurns, QueryAbortedError } from "../utils/sdk-helpers.js";
import type { Config } from "../utils/config.js";
import { StackResearchResultSchema } from "../types/llm-schemas.js";
import { extractFirstJson, wrapUserInput } from "../utils/shared.js";
import { isValidScope, isValidOssType } from "../utils/type-guards.js";
import type { LayeredMemory } from "../memory/layers.js";

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

export async function researchStack(
  architecture: ArchDesign,
  domain: DomainAnalysis,
  config?: Config,
  signal?: AbortSignal,
  memory?: LayeredMemory,
): Promise<StackEnvironment> {
  const techList = Object.entries(architecture.techStack)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  const persist = async (env: StackEnvironment): Promise<StackEnvironment> => {
    if (memory) {
      try {
        await persistL2Facts(env, domain, architecture, memory, config);
      } catch (err) {
        console.warn(
          `[stack-researcher] L2 fact persistence failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return env;
  };

  let resultText: string;

  try {
    const { result } = await consumeQuery(
      query({
        prompt: `${RESEARCH_PROMPT}

${wrapUserInput("tech-context", `Tech Stack:\n${techList}\n\nDomain: ${domain.classification}\nSpecializations: ${domain.specializations.join(", ")}\nRecommended MCP servers: ${domain.requiredMcpServers.join(", ")}`)}`,
        options: {
          tools: ["WebSearch", "WebFetch"],
          ...getQueryPermissions(config),
          maxTurns: getMaxTurns(config, "stackResearch"),
        },
      }),
      { label: "stack-research", ...(signal ? { signal } : {}) }
    );
    resultText = result;
  } catch (err) {
    if (err instanceof QueryAbortedError) throw err;
    console.warn(`[stack-researcher] Query failed: ${err instanceof Error ? err.message : String(err)}`);
    return persist(getDefaultEnvironment(architecture, domain));
  }

  const jsonStr = extractFirstJson(resultText);
  if (!jsonStr) {
    return persist(getDefaultEnvironment(architecture, domain));
  }

  try {
    const parseResult = StackResearchResultSchema.safeParse(JSON.parse(jsonStr));
    if (!parseResult.success) return persist(getDefaultEnvironment(architecture, domain));
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

    return persist({ lspServers, mcpServers, plugins, openSourceTools, claudeMd });
  } catch {
    return persist(getDefaultEnvironment(architecture, domain));
  }
}

async function persistL2Facts(
  env: StackEnvironment,
  domain: DomainAnalysis,
  architecture: ArchDesign,
  memory: LayeredMemory,
  config?: Config,
): Promise<void> {
  if (config && (config.memory?.enabled === false || config.memory?.layers?.enabled === false)) {
    return;
  }

  const writeFact = async (key: string, value: string): Promise<void> => {
    if (!value) return;
    await memory.l2.upsertFact(key, value);
    console.log(`[stack-researcher] Wrote L2 fact: ${key}`);
  };

  for (const lsp of env.lspServers) {
    if (lsp.language && lsp.server) {
      await writeFact(`stack.lsp.${lsp.language}`, lsp.server);
    }
  }

  for (const mcp of env.mcpServers) {
    if (mcp.name && mcp.source) {
      await writeFact(`stack.mcp.${mcp.name}`, mcp.source);
    }
  }

  if (domain.classification) {
    await writeFact("stack.domain", domain.classification);
  }

  const techValues = Object.values(architecture.techStack).filter((v) => v && v.length > 0);
  if (techValues.length > 0) {
    await writeFact("stack.tech", techValues.join(", "));
  }
}

function getDefaultEnvironment(
  architecture: ArchDesign,
  _domain: DomainAnalysis
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
