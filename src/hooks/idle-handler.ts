import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

/**
 * TeammateIdle hook: detects idle agents and suggests shutdown or task reassignment.
 */
export const idleHandlerHook: HookCallback = async (input, _toolUseID, _ctx) => {
  if (input.hook_event_name !== "TeammateIdle") return {};

  const agent = "teammate_name" in input ? input.teammate_name : "unknown";

  return {
    systemMessage:
      `Agent "${agent}" is idle. Consider reassigning to pending work or shutting down to free resources.`,
  };
};
