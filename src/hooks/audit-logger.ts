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

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null;
}

export const auditLoggerHook: HookCallback = async (input, _toolUseID, _ctx) => {
  if (input.hook_event_name !== "PostToolUse") return {};

  const toolInput = isRecord(input.tool_input) ? input.tool_input : {};
  const filePath = typeof toolInput.file_path === "string" ? toolInput.file_path : undefined;

  if (!filePath) return {};

  const dir = dirname(AUDIT_LOG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    toolName: input.tool_name,
    filePath,
    event: input.hook_event_name,
  };

  appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + "\n");

  return {};
};
