import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/** Type guard for plain objects — replaces duplicates in config.ts, audit-logger.ts, security.ts */
export function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null;
}

/** Type guard for API retry messages — replaces duplicates in sdk-helpers.ts, mutation-engine.ts, verifiers.ts */
export function isApiRetry(
  message: SDKMessage
): message is Extract<SDKMessage, { subtype: "api_retry" }> {
  if (message.type !== "system" || !("subtype" in message)) return false;
  const record: Record<string, unknown> = message;
  return record.subtype === "api_retry";
}
