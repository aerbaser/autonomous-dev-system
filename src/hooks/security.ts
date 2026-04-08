import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { isRecord } from "../utils/shared.js";

const DENY_PATTERNS = [
  /\brm\s+(-\w+\s+)*-r/,          // rm -rf, rm -r, rm -fr, etc.
  /\bsudo\b/,
  /\bdd\b\s/,
  /\bmkfs\b/,
  /\bshred\b/,
  /\bbash\s+-i\b/,
  /\bchmod\s+777\b/,
  /\bchown\b.*\broot\b/,
  /\bcurl\b.*\|\s*(ba)?sh/,
  /\bwget\b.*\|\s*(ba)?sh/,
  /\bnpm\s+config\s+set\b/,
  /--unsafe-perm/,
] as const;

const DENIED_PATHS = [
  /\.ssh\//,
  /\.aws\//,
  /\.netrc$/,
  /\.env($|\.)/,           // matches .env, .env.local, .env.production, etc.
  /credentials\.json$/,
  /\.pem$/,
  /id_rsa/,
] as const;

export const securityHook: HookCallback = async (input, _toolUseID, _ctx) => {
  if (input.hook_event_name !== "PreToolUse") return {};

  const toolName = input.tool_name;
  const toolInput = isRecord(input.tool_input) ? input.tool_input : {};

  if (toolName === "Bash") {
    const command = typeof toolInput.command === "string" ? toolInput.command : undefined;
    if (command) {
      // Split on shell command separators (not pipe — pipe is part of curl|sh patterns)
      const parts = command.split(/\s*(?:&&|\|\||;)\s*/);
      for (const part of parts) {
        for (const pattern of DENY_PATTERNS) {
          if (pattern.test(part)) {
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse" as const,
                permissionDecision: "deny" as const,
                permissionDecisionReason: `Blocked dangerous command: ${command.slice(0, 100)}`,
              },
            };
          }
        }
      }
    }
  }

  if (["Read", "Write", "Edit"].includes(toolName)) {
    const filePath = typeof toolInput.file_path === "string" ? toolInput.file_path : undefined;
    if (filePath) {
      for (const pattern of DENIED_PATHS) {
        if (pattern.test(filePath)) {
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse" as const,
              permissionDecision: "deny" as const,
              permissionDecisionReason: `Access denied to sensitive path: ${filePath}`,
            },
          };
        }
      }
    }
  }

  return {};
};
