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

// --- Query permissions from config ---

import { MAX_TURNS_DEFAULTS, type Config } from "./config.js";

export interface QueryPermissions {
  permissionMode: "bypassPermissions" | "default";
  allowDangerouslySkipPermissions: boolean;
}

const BYPASS_PERMISSIONS: QueryPermissions = { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true };
const DEFAULT_PERMISSIONS: QueryPermissions = { permissionMode: "default", allowDangerouslySkipPermissions: false };

export function getQueryPermissions(config?: Config): QueryPermissions {
  return (!config || config.autonomousMode) ? BYPASS_PERMISSIONS : DEFAULT_PERMISSIONS;
}

// --- Max turns from config ---

export type MaxTurnsKey = keyof Config["maxTurns"];

export function getMaxTurns(config: Config | undefined, key: MaxTurnsKey): number {
  return config?.maxTurns?.[key] ?? MAX_TURNS_DEFAULTS[key];
}

