import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { McpDiscovery, McpServerConfig } from "../state/project-state.js";
import { validateMcp } from "./validator.js";

// --- Discovery types ---

export type TrustTier = "official" | "community" | "other";

export interface McpDiscoveryEntry {
  name: string;
  packageName: string;
  trustTier: TrustTier;
  installCommand: string;
}

const KNOWN_MCP_SERVERS = {
  postgresql: {
    name: "postgres",
    packageName: "@modelcontextprotocol/server-postgres",
    trustTier: "official",
    installCommand: "npx @modelcontextprotocol/server-postgres",
  },
  postgres: {
    name: "postgres",
    packageName: "@modelcontextprotocol/server-postgres",
    trustTier: "official",
    installCommand: "npx @modelcontextprotocol/server-postgres",
  },
  redis: {
    name: "redis",
    packageName: "redis-mcp",
    trustTier: "community",
    installCommand: "npx redis-mcp",
  },
  playwright: {
    name: "playwright",
    packageName: "@anthropic-ai/mcp-playwright",
    trustTier: "official",
    installCommand: "npx @anthropic-ai/mcp-playwright",
  },
  github: {
    name: "github",
    packageName: "@modelcontextprotocol/server-github",
    trustTier: "official",
    installCommand: "npx @modelcontextprotocol/server-github",
  },
  docker: {
    name: "docker",
    packageName: "docker-mcp",
    trustTier: "community",
    installCommand: "npx docker-mcp",
  },
} as const satisfies Record<string, McpDiscoveryEntry>;

type McpServerKey = keyof typeof KNOWN_MCP_SERVERS;

function isMcpServerKey(key: string): key is McpServerKey {
  return key in KNOWN_MCP_SERVERS;
}

const TRUST_SCORES = {
  official: 3,
  community: 2,
  other: 1,
} as const satisfies Record<TrustTier, number>;

/**
 * Discover MCP servers relevant to the given tech stack and domain.
 * Maps known stack keywords to curated MCP servers.
 */
export function discoverMcpServers(
  techStack: string[],
  _domain: string
): McpDiscoveryEntry[] {
  const seen = new Set<string>();
  const results: McpDiscoveryEntry[] = [];

  for (const tech of techStack) {
    const key = tech.toLowerCase();
    if (!isMcpServerKey(key)) continue;
    const entry = KNOWN_MCP_SERVERS[key];
    if (!seen.has(entry.packageName)) {
      seen.add(entry.packageName);
      results.push(entry);
    }
  }

  return prioritizeMcpServers(results);
}

/**
 * Sort MCP servers by trust tier (official first, then community, then other).
 */
export function prioritizeMcpServers(
  servers: McpDiscoveryEntry[]
): McpDiscoveryEntry[] {
  return [...servers].sort(
    (a, b) => TRUST_SCORES[b.trustTier] - TRUST_SCORES[a.trustTier]
  );
}

/**
 * Merge discovered MCP servers into the project's .mcp.json config.
 */
export function configureMcpServers(
  projectDir: string,
  servers: McpDiscovery[]
): McpDiscovery[] {
  const mcpConfigPath = resolve(projectDir, ".mcp.json");

  // Load existing config
  let existingConfig: { mcpServers?: Record<string, McpServerConfig> } = {};
  if (existsSync(mcpConfigPath)) {
    try {
      existingConfig = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
    } catch {
      existingConfig = {};
    }
  }

  const mcpServers = existingConfig.mcpServers ?? {};

  const results = servers.map((server) => {
    const validation = validateMcp(server);
    if (!validation.valid) {
      console.log(`[mcp] Skipping ${server.name}: ${validation.reason}`);
      return server;
    }

    if (mcpServers[server.name]) {
      console.log(`[mcp] Already configured: ${server.name}`);
      return { ...server, installed: true };
    }

    console.log(`[mcp] Configuring: ${server.name} (${server.reason})`);
    mcpServers[server.name] = server.config;
    return { ...server, installed: true };
  });

  // Write updated config
  writeFileSync(
    mcpConfigPath,
    JSON.stringify({ mcpServers }, null, 2)
  );

  return results;
}

/**
 * Get MCP server configs suitable for Agent SDK query() options.
 */
export function getMcpServerConfigs(
  servers: McpDiscovery[]
): Record<string, McpServerConfig> {
  const configs: Record<string, McpServerConfig> = {};
  for (const server of servers.filter((s) => s.installed)) {
    configs[server.name] = server.config;
  }
  return configs;
}
