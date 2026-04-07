import type { LspConfig, McpDiscovery, PluginDiscovery } from "../state/project-state.js";

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

/** Security patterns to reject */
const SUSPICIOUS_PATTERNS = [
  /exfiltrat/i,
  /reverse.?shell/i,
  /keylog/i,
  /credential.?steal/i,
  /\.ssh/,
  /\.aws/,
  /\.netrc/,
];

export function validateLsp(lsp: LspConfig): ValidationResult {
  // LSP servers are generally safe — they only read code
  if (!lsp.server || !lsp.installCommand) {
    return { valid: false, reason: "Missing server name or install command" };
  }
  return { valid: true };
}

export function validateMcp(mcp: McpDiscovery): ValidationResult {
  if (!mcp.name || !mcp.config.command) {
    return { valid: false, reason: "Missing name or command" };
  }

  // Check for suspicious patterns in config
  const configStr = JSON.stringify(mcp.config);
  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.test(configStr)) {
      return { valid: false, reason: `Suspicious pattern in config: ${pattern}` };
    }
  }

  return { valid: true };
}

export function validatePlugin(plugin: PluginDiscovery): ValidationResult {
  if (!plugin.name || !plugin.source) {
    return { valid: false, reason: "Missing name or source" };
  }

  // Only allow project-scoped plugins for security
  if (plugin.scope !== "project" && plugin.scope !== "user") {
    return { valid: false, reason: `Invalid scope: ${plugin.scope}` };
  }

  return { valid: true };
}
