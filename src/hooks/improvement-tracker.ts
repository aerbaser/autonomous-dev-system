import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const TRACKER_LOG_PATH = resolve(".autonomous-dev", "improvement-data.jsonl");

// In-memory map of tool use start times for duration tracking
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

/**
 * PreToolUse + PostToolUse + PostToolUseFailure hook:
 * Collects data for the self-improvement optimizer with duration tracking.
 */
export const improvementTrackerHook: HookCallback = async (input, toolUseID, _ctx) => {
  const event = input.hook_event_name;

  // Track start time on PreToolUse
  if (event === "PreToolUse" && toolUseID) {
    toolStartTimes.set(toolUseID, Date.now());
    return {};
  }

  const isPost = event === "PostToolUse";
  const isFailure = event === "PostToolUseFailure";
  if (!isPost && !isFailure) return {};

  const inp = input as Record<string, unknown>;

  // Calculate duration if we captured the start time
  let durationMs: number | undefined;
  if (toolUseID && toolStartTimes.has(toolUseID)) {
    durationMs = Date.now() - toolStartTimes.get(toolUseID)!;
    toolStartTimes.delete(toolUseID);
  }

  const record: ToolUsageRecord = {
    timestamp: new Date().toISOString(),
    toolName: inp.tool_name as string,
    agentId: inp.agent_id as string | undefined,
    agentType: inp.agent_type as string | undefined,
    success: isPost,
    durationMs,
    error: isFailure ? (inp.error as string | undefined) : undefined,
  };

  const dir = dirname(TRACKER_LOG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(TRACKER_LOG_PATH, JSON.stringify(record) + "\n");

  return {};
};
