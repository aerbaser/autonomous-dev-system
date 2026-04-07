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
  /eval\s*\(/i,
  /child_process/i,
  /base64.*decode/i,
  /wget\s/,
  /curl.*-o/,
];

/** Validate URL format for MCP server sources */
export function isValidSource(source: string): boolean {
  if (!source) return false;
  // Allow well-known package managers
  if (["npm", "pypi", "github", "local"].includes(source.toLowerCase())) {
    return true;
  }
  // Validate URL format
  try {
    const url = new URL(source);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    // Allow simple non-URL identifiers (marketplace names, etc.)
    return /^[a-zA-Z0-9_-]+$/.test(source);
  }
}

/** Validate an install command for dangerous patterns */
export function validateInstallCommand(command: string): ValidationResult {
  if (!command || !command.trim()) {
    return { valid: false, reason: "Empty install command" };
  }

  const dangerousPatterns = [
    /curl.*\|.*sh/i,
    /wget.*\|.*sh/i,
    /eval\s*\(/i,
    /rm\s+-rf/i,
    /sudo\s/i,
    /chmod\s+777/,
    />\s*\/etc\//,
    />\s*\/usr\//,
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(command)) {
      return { valid: false, reason: `Dangerous pattern in install command: ${pattern}` };
    }
  }

  return { valid: true };
}

export function validateLsp(lsp: LspConfig): ValidationResult {
  // LSP servers are generally safe — they only read code
  if (!lsp.server || !lsp.installCommand) {
    return { valid: false, reason: "Missing server name or install command" };
  }

  // Validate the install command itself
  const cmdValidation = validateInstallCommand(lsp.installCommand);
  if (!cmdValidation.valid) {
    return cmdValidation;
  }

  return { valid: true };
}

export function validateMcp(mcp: McpDiscovery): ValidationResult {
  if (!mcp.name || !mcp.config.command) {
    return { valid: false, reason: "Missing name or command" };
  }

  // Validate source URL/identifier
  if (mcp.source && !isValidSource(mcp.source)) {
    return { valid: false, reason: `Invalid source: ${mcp.source}` };
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
