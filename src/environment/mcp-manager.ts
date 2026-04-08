import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { McpDiscovery, McpServerConfig } from "../state/project-state.js";
import { validateMcp } from "./validator.js";

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
