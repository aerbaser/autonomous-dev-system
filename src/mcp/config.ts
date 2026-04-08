import type { McpServerConfig } from "../state/project-state.js";

export const DEFAULT_MCP_SERVERS = {
  playwright: {
    command: "npx",
    args: ["@playwright/mcp@latest"],
  },
  github: {
    command: "npx",
    args: ["@anthropic-ai/mcp-github"],
  },
} as const satisfies Record<string, Readonly<McpServerConfig>>;

export const DOMAIN_MCP_SERVERS: Record<string, Record<string, McpServerConfig>> = {
  "web-application": {
    playwright: DEFAULT_MCP_SERVERS.playwright,
  },
  "fintech/trading": {},
  "data-science": {},
};
