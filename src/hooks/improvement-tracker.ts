import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const TRACKER_LOG_PATH = process.env.TRACKER_LOG_PATH
  ?? resolve(".autonomous-dev", "improvement-data.jsonl");

const toolStartTimes = new Map<string, number>();
const TOOL_START_TTL_MS = 5 * 60 * 1000; // 5 minutes

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
    // Evict stale entries to prevent unbounded growth
    const cutoff = Date.now() - TOOL_START_TTL_MS;
    for (const [id, ts] of toolStartTimes) {
      if (ts < cutoff) toolStartTimes.delete(id);
    }
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
    success: event === "PostToolUse",
    ...(input.agent_id !== undefined ? { agentId: input.agent_id } : {}),
    ...(input.agent_type !== undefined ? { agentType: input.agent_type } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(event === "PostToolUseFailure" && input.error ? { error: input.error } : {}),
  };

  const dir = dirname(TRACKER_LOG_PATH);
  mkdirSync(dir, { recursive: true });
  appendFileSync(TRACKER_LOG_PATH, JSON.stringify(record) + "\n");

  return {};
};
