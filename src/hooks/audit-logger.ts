import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const AUDIT_LOG_PATH = resolve(".autonomous-dev", "audit.jsonl");

interface AuditEntry {
  timestamp: string;
  toolName: string;
  filePath?: string;
  event: string;
}

/**
 * PostToolUse hook: logs all file modifications as JSONL for traceability.
 */
export const auditLoggerHook: HookCallback = async (input, _toolUseID, _ctx) => {
  if (input.hook_event_name !== "PostToolUse") return {};

  const inp = input as Record<string, unknown>;
  const toolInput = inp.tool_input as Record<string, unknown> | undefined;
  const filePath = toolInput?.file_path as string | undefined;
  const toolName = inp.tool_name as string | undefined;

  if (!filePath) return {};

  const dir = dirname(AUDIT_LOG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    toolName: toolName ?? "unknown",
    filePath,
    event: input.hook_event_name,
  };

  appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + "\n");

  return {};
};
