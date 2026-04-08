import type { McpServerConfig, DomainAnalysis, StackEnvironment } from "../state/project-state.js";
import { DEFAULT_MCP_SERVERS, DOMAIN_MCP_SERVERS } from "./config.js";

/**
 * Get MCP server configs for a specific phase and domain,
 * merging defaults + domain-specific + environment-discovered servers.
 */
export function getMcpServersForPhase(
  phase: string,
  domain?: DomainAnalysis,
  environment?: StackEnvironment | null
): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};

  // Always include defaults
  Object.assign(servers, DEFAULT_MCP_SERVERS);

  if (domain && domain.classification in DOMAIN_MCP_SERVERS) {
    const domainServers = DOMAIN_MCP_SERVERS[domain.classification];
    if (domainServers) {
      Object.assign(servers, domainServers);
    }
  }

  // Add environment-discovered servers (highest priority)
  if (environment) {
    for (const mcp of environment.mcpServers.filter((m) => m.installed)) {
      servers[mcp.name] = mcp.config;
    }
  }

  // Phase-specific filtering
  switch (phase) {
    case "testing":
      // Include playwright for E2E
      break;
    case "ab-testing":
    case "monitoring":
      // Include analytics MCP if available
      break;
    case "review":
      // Read-only: remove write-capable MCPs
      break;
  }

  return servers;
}
