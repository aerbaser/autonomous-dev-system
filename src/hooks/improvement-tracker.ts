import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const TRACKER_LOG_PATH = resolve(".autonomous-dev", "improvement-data.jsonl");

interface ToolUsageRecord {
  timestamp: string;
  toolName: string;
  agentId?: string;
  agentType?: string;
  success: boolean;
  error?: string;
}

/**
 * PostToolUse + PostToolUseFailure hook: collects data for the self-improvement optimizer.
 */
export const improvementTrackerHook: HookCallback = async (input, _toolUseID, _ctx) => {
  const isPost = input.hook_event_name === "PostToolUse";
  const isFailure = input.hook_event_name === "PostToolUseFailure";
  if (!isPost && !isFailure) return {};

  const inp = input as Record<string, unknown>;

  const record: ToolUsageRecord = {
    timestamp: new Date().toISOString(),
    toolName: inp.tool_name as string,
    agentId: inp.agent_id as string | undefined,
    agentType: inp.agent_type as string | undefined,
    success: isPost,
    error: isFailure ? (inp.error as string | undefined) : undefined,
  };

  const dir = dirname(TRACKER_LOG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(TRACKER_LOG_PATH, JSON.stringify(record) + "\n");

  return {};
};
