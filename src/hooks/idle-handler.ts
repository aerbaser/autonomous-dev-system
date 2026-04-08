import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

const DEFAULT_IDLE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

interface IdlePayload {
  idle_duration_ms: number;
  pending_tasks: Array<{ id: string; title: string }>;
  idle_threshold_ms: number;
}

function extractPayload(input: Record<string, unknown>): IdlePayload {
  return {
    idle_duration_ms: typeof input.idle_duration_ms === "number" ? input.idle_duration_ms : 0,
    pending_tasks: Array.isArray(input.pending_tasks) ? input.pending_tasks : [],
    idle_threshold_ms: typeof input.idle_threshold_ms === "number"
      ? input.idle_threshold_ms
      : DEFAULT_IDLE_THRESHOLD_MS,
  };
}

/**
 * TeammateIdle hook: detects idle agents and suggests shutdown or task reassignment.
 */
export const idleHandlerHook: HookCallback = async (input, _toolUseID, _ctx) => {
  if (input.hook_event_name !== "TeammateIdle") return {};

  const { idle_duration_ms, pending_tasks, idle_threshold_ms } = extractPayload(
    input,
  );

  if (idle_duration_ms < idle_threshold_ms) {
    return {};
  }

  const agent = input.teammate_name;
  const idleMinutes = Math.round(idle_duration_ms / 60_000);

  if (pending_tasks.length > 0) {
    const next = pending_tasks[0]!;
    return {
      systemMessage:
        `Agent "${agent}" has been idle for ${idleMinutes}m. ` +
        `Reassign to pending task: [${next.id}] ${next.title}`,
    };
  }

  return {
    systemMessage:
      `Agent "${agent}" has been idle for ${idleMinutes}m with no pending tasks. ` +
      `Recommend shutdown to free resources.`,
  };
};
