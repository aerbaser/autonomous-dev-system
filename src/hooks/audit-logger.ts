import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { isRecord } from "../utils/shared.js";

const AUDIT_LOG_PATH = process.env['AUDIT_LOG_PATH']
  ?? resolve(".autonomous-dev", "audit.jsonl");

interface AuditEntry {
  timestamp: string;
  toolName: string;
  event: string;
  filePath?: string;
  command?: string;
  summary?: string;
}

export const auditLoggerHook: HookCallback = async (input, _toolUseID, _ctx) => {
  if (input.hook_event_name !== "PostToolUse") return {};

  const toolInput = isRecord(input.tool_input) ? input.tool_input : {};

  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    toolName: input.tool_name,
    event: input.hook_event_name,
  };

  // Log file operations
  if (typeof toolInput['file_path'] === "string") {
    entry.filePath = toolInput['file_path'];
  }

  // Log Bash commands
  if (typeof toolInput['command'] === "string") {
    entry.command = toolInput['command'].slice(0, 500);
  }

  // Log a summary for other tool types
  if (!entry.filePath && !entry.command) {
    const keys = Object.keys(toolInput);
    entry.summary = `params: ${keys.join(", ") || "(none)"}`;
  }

  const dir = dirname(AUDIT_LOG_PATH);
  mkdirSync(dir, { recursive: true });

  appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + "\n");

  return {};
};
