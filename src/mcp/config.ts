import type { McpServerConfig } from "../state/project-state.js";

/** Default MCP servers available for all projects */
export const DEFAULT_MCP_SERVERS: Record<string, McpServerConfig> = {
  playwright: {
    command: "npx",
    args: ["@playwright/mcp@latest"],
  },
  github: {
    command: "npx",
    args: ["@anthropic-ai/mcp-github"],
  },
};

/** Domain-specific MCP servers */
export const DOMAIN_MCP_SERVERS: Record<string, Record<string, McpServerConfig>> = {
  "web-application": {
    playwright: DEFAULT_MCP_SERVERS.playwright,
  },
  "fintech/trading": {
    // These would be real MCP servers when available
  },
  "data-science": {
    // jupyter MCP, etc.
  },
};
