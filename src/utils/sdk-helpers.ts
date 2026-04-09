import type { Query, SDKMessage, SDKResultError } from "@anthropic-ai/claude-agent-sdk";
import { isApiRetry } from "./shared.js";
import type { EventBus } from "../events/event-bus.js";
import type { Phase } from "../state/project-state.js";

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

export interface ConsumeQueryOptions {
  label?: string;
  onMessage?: (message: SDKMessage) => void;
  eventBus?: EventBus;
  phase?: Phase;
  agentName?: string;
  model?: string;
}

export async function consumeQuery(
  queryStream: Query,
  labelOrOptions?: string | ConsumeQueryOptions,
  onMessage?: (message: SDKMessage) => void,
): Promise<QueryResult> {
  // Support both old signature consumeQuery(stream, label, onMessage)
  // and new signature consumeQuery(stream, options)
  let label: string | undefined;
  let eventBus: EventBus | undefined;
  let phase: Phase | undefined;
  let agentName: string | undefined;
  let model: string | undefined;

  if (typeof labelOrOptions === "string") {
    label = labelOrOptions;
  } else if (labelOrOptions) {
    label = labelOrOptions.label;
    onMessage = labelOrOptions.onMessage ?? onMessage;
    eventBus = labelOrOptions.eventBus;
    phase = labelOrOptions.phase;
    agentName = labelOrOptions.agentName;
    model = labelOrOptions.model;
  }

  const tag = label ? `[${label}]` : "[query]";
  const startMs = Date.now();

  if (eventBus && phase && agentName) {
    eventBus.emit("agent.query.start", {
      phase,
      agentName,
      model: model ?? "unknown",
      promptLength: 0, // prompt length unavailable from SDK stream
    });
  }

  let lastToolStartMs = 0;
  let lastToolName = "";

  for await (const message of queryStream) {
    if (onMessage) {
      onMessage(message);
    }

    // Emit tool events
    if (eventBus && phase && agentName) {
      if (message.type === "assistant" && "tool_use" in message) {
        const toolMsg = message as unknown as { tool_use?: { name: string; input: unknown } };
        if (toolMsg.tool_use) {
          lastToolName = toolMsg.tool_use.name;
          lastToolStartMs = Date.now();
          eventBus.emit("agent.tool.use", {
            phase,
            agentName,
            toolName: lastToolName,
            inputSummary: typeof toolMsg.tool_use.input === "string"
              ? toolMsg.tool_use.input.slice(0, 200)
              : JSON.stringify(toolMsg.tool_use.input).slice(0, 200),
          });
        }
      }

      if (message.type === "tool_use_summary") {
        eventBus.emit("agent.tool.result", {
          phase,
          agentName,
          toolName: lastToolName,
          success: !("error" in message),
          durationMs: lastToolStartMs > 0 ? Date.now() - lastToolStartMs : 0,
        });
      }
    }

    if (message.type === "result") {
      if (message.subtype === "success") {
        const result: QueryResult = {
          result: message.result,
          sessionId: message.session_id,
          cost: message.total_cost_usd,
          turns: message.num_turns,
          structuredOutput: message.structured_output,
        };

        if (eventBus && phase && agentName) {
          eventBus.emit("agent.query.end", {
            phase,
            agentName,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: message.total_cost_usd,
            durationMs: Date.now() - startMs,
            success: true,
          });
        }

        return result;
      }

      if (eventBus && phase && agentName) {
        eventBus.emit("agent.query.end", {
          phase,
          agentName,
          inputTokens: 0, // token counts unavailable from SDK stream
          outputTokens: 0, // token counts unavailable from SDK stream
          costUsd: message.total_cost_usd,
          durationMs: Date.now() - startMs,
          success: false,
        });
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

