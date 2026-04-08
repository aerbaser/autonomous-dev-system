import type { Query, SDKMessage, SDKResultError } from "@anthropic-ai/claude-agent-sdk";
import { isApiRetry } from "./shared.js";

export interface QueryResult {
  result: string;
  sessionId: string;
  cost: number;
  turns: number;
  structuredOutput?: unknown;
}

export class QueryExecutionError extends Error {
  public readonly errors: string[];
  public readonly subtype: SDKResultError["subtype"];
  public readonly sessionId: string;
  public readonly cost: number;

  constructor(resultError: SDKResultError) {
    const summary = resultError.errors.length > 0
      ? resultError.errors.join("; ")
      : `Query failed with subtype: ${resultError.subtype}`;
    super(summary);
    this.name = "QueryExecutionError";
    this.errors = resultError.errors;
    this.subtype = resultError.subtype;
    this.sessionId = resultError.session_id;
    this.cost = resultError.total_cost_usd;
  }
}

// --- Streaming output ---

export function streamToConsole(message: SDKMessage): void {
  if (message.type === "assistant" && "content" in message) {
    const msg = message as { content?: Array<{ type: string; text?: string }> };
    for (const block of msg.content ?? []) {
      if (block.type === "text" && block.text) {
        process.stdout.write(block.text);
      }
    }
  }
}

export async function consumeQuery(
  queryStream: Query,
  label?: string,
  onMessage?: (message: SDKMessage) => void,
): Promise<QueryResult> {
  const tag = label ? `[${label}]` : "[query]";

  for await (const message of queryStream) {
    if (onMessage) {
      onMessage(message);
    }

    if (message.type === "result") {
      if (message.subtype === "success") {
        return {
          result: message.result,
          sessionId: message.session_id,
          cost: message.total_cost_usd,
          turns: message.num_turns,
          structuredOutput: message.structured_output,
        };
      }

      console.error(`${tag} Query error (${message.subtype}): ${message.errors.join("; ")}`);
      throw new QueryExecutionError(message);
    }

    if (message.type === "system" && isApiRetry(message)) {
      console.warn(
        `${tag} API retry ${message.attempt}/${message.max_retries} ` +
        `(status=${message.error_status ?? "unknown"}, delay=${message.retry_delay_ms}ms)`
      );
    }
  }

  throw new Error(`${tag} Query stream ended without a result message`);
}

// --- Permission model ---

export type PermissionLevel = "bypass" | "auto" | "interactive";

export function getPermissionMode(level?: PermissionLevel): "bypassPermissions" | "auto" | "default" {
  if (level === undefined) return "default";
  switch (level) {
    case "bypass": return "bypassPermissions";
    case "auto": return "auto";
    case "interactive": return "default";
    default: {
      const _exhaustive: never = level;
      throw new Error(`Unknown permission level: ${_exhaustive}`);
    }
  }
}

// --- Query permissions from config ---

import type { Config } from "./config.js";

export interface QueryPermissions {
  permissionMode: "bypassPermissions" | "default";
  allowDangerouslySkipPermissions: boolean;
}

export function getQueryPermissions(config?: Config): QueryPermissions {
  if (!config || config.autonomousMode) {
    return { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true };
  }
  return { permissionMode: "default", allowDangerouslySkipPermissions: false };
}

// --- Max turns from config ---

export type MaxTurnsKey = keyof Config["maxTurns"];

const MAX_TURNS_FALLBACKS: Record<MaxTurnsKey, number> = {
  default: 50, decomposition: 3, development: 200, qualityFix: 30,
  testing: 30, review: 20, deployment: 20, monitoring: 10,
  ideation: 10, architecture: 10, abTesting: 10, stackResearch: 15,
  domainAnalysis: 5, ossScan: 10,
};

export function getMaxTurns(config: Config | undefined, key: MaxTurnsKey): number {
  return config?.maxTurns?.[key] ?? MAX_TURNS_FALLBACKS[key];
}

// --- Cost estimation ---

export interface CostEstimate {
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
}

export function estimateCost(inputTokens: number, outputTokens: number, model: string): CostEstimate {
  // Approximate pricing per 1M tokens
  const pricing: Record<string, { input: number; output: number }> = {
    "claude-opus-4-6": { input: 15, output: 75 },
    "claude-sonnet-4-6": { input: 3, output: 15 },
    "claude-haiku-4-5-20251001": { input: 0.8, output: 4 },
  };
  const defaultPricing = { input: 3, output: 15 };
  const p = pricing[model] ?? defaultPricing;
  const estimatedUsd = (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
  return { inputTokens, outputTokens, estimatedUsd };
}
