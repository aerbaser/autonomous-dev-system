import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const TRACKER_LOG_PATH = resolve(".autonomous-dev", "improvement-data.jsonl");

const toolStartTimes = new Map<string, number>();

interface ToolUsageRecord {
  timestamp: string;
  toolName: string;
  agentId?: string;
  agentType?: string;
  success: boolean;
  durationMs?: number;
  error?: string;
}

export const improvementTrackerHook: HookCallback = async (input, toolUseID, _ctx) => {
  const event = input.hook_event_name;

  if (event === "PreToolUse" && toolUseID) {
    toolStartTimes.set(toolUseID, Date.now());
    return {};
  }

  if (event !== "PostToolUse" && event !== "PostToolUseFailure") return {};

  let durationMs: number | undefined;
  if (toolUseID && toolStartTimes.has(toolUseID)) {
    durationMs = Date.now() - toolStartTimes.get(toolUseID)!;
    toolStartTimes.delete(toolUseID);
  }

  const record: ToolUsageRecord = {
    timestamp: new Date().toISOString(),
    toolName: input.tool_name,
    agentId: input.agent_id,
    agentType: input.agent_type,
    success: event === "PostToolUse",
    durationMs,
    error: event === "PostToolUseFailure" ? input.error : undefined,
  };

  const dir = dirname(TRACKER_LOG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(TRACKER_LOG_PATH, JSON.stringify(record) + "\n");

  return {};
};
