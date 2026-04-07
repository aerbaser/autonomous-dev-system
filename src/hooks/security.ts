import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

/** Patterns that should be blocked entirely */
const DENY_PATTERNS = [
  /^rm\s+-rf\s/,
  /^rm\s+-r\s/,
  /^rm\s+-fr\s/,
  /^sudo\s/,
  /^dd\s/,
  /^mkfs\s/,
  /^shred\s/,
  /^bash\s+-i/,
  /^chmod\s+777/,
  /^chown.*root/,
  /^curl.*\|.*sh/,
  /^wget.*\|.*sh/,
  /^npm\s+config\s+set/,
  /--unsafe-perm/,
];

/** Paths that should never be read or written */
const DENIED_PATHS = [
  /\.ssh\//,
  /\.aws\//,
  /\.netrc$/,
  /\.env$/,
  /credentials\.json$/,
];

/**
 * PreToolUse hook: blocks dangerous operations and sensitive file access.
 */
export const securityHook: HookCallback = async (input, _toolUseID, _ctx) => {
  if (input.hook_event_name !== "PreToolUse") return {};

  const inp = input as Record<string, unknown>;
  const toolInput = inp.tool_input as Record<string, unknown>;
  const toolName = inp.tool_name as string;

  // Check Bash commands
  if (toolName === "Bash") {
    const command = toolInput?.command as string | undefined;
    if (command) {
      for (const pattern of DENY_PATTERNS) {
        if (pattern.test(command)) {
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

  // Check file access
  if (["Read", "Write", "Edit"].includes(toolName)) {
    const filePath = toolInput?.file_path as string | undefined;
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
