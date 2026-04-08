import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

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
] as const;

const DENIED_PATHS = [
  /\.ssh\//,
  /\.aws\//,
  /\.netrc$/,
  /\.env$/,
  /credentials\.json$/,
] as const;

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null;
}

export const securityHook: HookCallback = async (input, _toolUseID, _ctx) => {
  if (input.hook_event_name !== "PreToolUse") return {};

  const toolName = input.tool_name;
  const toolInput = isRecord(input.tool_input) ? input.tool_input : {};

  if (toolName === "Bash") {
    const command = typeof toolInput.command === "string" ? toolInput.command : undefined;
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
