import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { McpDiscovery, McpServerConfig } from "../state/project-state.js";
import { validateMcp } from "./validator.js";

// Flags that allow arbitrary code execution — block them in LLM-generated MCP configs
const DANGEROUS_MCP_FLAGS = new Set(['--eval', '-e', '-c', '--require', '-r']);

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

    // Reject MCP configs with dangerous flags that allow arbitrary code execution
    const dangerousArg = server.config.args?.find((arg) => DANGEROUS_MCP_FLAGS.has(arg));
    if (dangerousArg !== undefined) {
      console.log(`[mcp] Blocked ${server.name}: dangerous flag '${dangerousArg}' in args`);
      return server;
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
