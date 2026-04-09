import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

export const notificationHook: HookCallback = async (input, _toolUseID, ctx) => {
  if (input.hook_event_name !== "Notification") return {};

  const webhookUrl = process.env['SLACK_WEBHOOK_URL'];
  if (!webhookUrl) return {};

  const message = input.message;

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `[autonomous-dev] ${message}` }),
      signal: ctx.signal,
    });
  } catch {
    // Don't fail the agent if notification fails
  }

  return {};
};
