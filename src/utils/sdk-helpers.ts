import type { Query, SDKMessage, SDKResultError } from "@anthropic-ai/claude-agent-sdk";
import { isApiRetry } from "./shared.js";
import type { EventBus } from "../events/event-bus.js";
import type { Phase } from "../state/project-state.js";
import { ALL_PHASES } from "../types/phases.js";
import { recordQueryTelemetry } from "../state/session-store.js";

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
  label?: string | undefined;
  onMessage?: ((message: SDKMessage) => void) | undefined;
  eventBus?: EventBus | undefined;
  phase?: Phase | undefined;
  agentName?: string | undefined;
  model?: string | undefined;
}

interface MessageWithToolUse {
  tool_use: { name: string; input: unknown };
}

function hasToolUse(msg: SDKMessage): msg is SDKMessage & MessageWithToolUse {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "tool_use" in msg &&
    typeof (msg as Record<string, unknown>)["tool_use"] === "object" &&
    (msg as Record<string, unknown>)["tool_use"] !== null
  );
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
  const tracePhase = phase ?? (label && ALL_PHASES.includes(label as Phase) ? (label as Phase) : undefined);
  const traceAgentName = agentName ?? label ?? "query";
  const telemetryPhase = tracePhase ?? label;

  console.log(
    `${tag} start` +
    (tracePhase ? ` phase=${tracePhase}` : "") +
    (traceAgentName ? ` agent=${traceAgentName}` : "") +
    (model ? ` model=${model}` : "")
  );

  if (eventBus && tracePhase && traceAgentName) {
    eventBus.emit("agent.query.start", {
      phase: tracePhase,
      agentName: traceAgentName,
      model: model ?? "unknown",
      promptLength: 0, // prompt length unavailable from SDK stream
      label,
    });
  }

  let lastToolStartMs = 0;
  let lastToolName = "";

  for await (const message of queryStream) {
    if (onMessage) {
      onMessage(message);
    }

    // Emit tool events
    if (eventBus && tracePhase && traceAgentName) {
      if (message.type === "assistant" && hasToolUse(message)) {
        lastToolName = message.tool_use.name;
        lastToolStartMs = Date.now();
        eventBus.emit("agent.tool.use", {
          phase: tracePhase,
          agentName: traceAgentName,
          toolName: lastToolName,
          inputSummary: typeof message.tool_use.input === "string"
            ? message.tool_use.input.slice(0, 200)
            : JSON.stringify(message.tool_use.input).slice(0, 200),
        });
      }

      if (message.type === "tool_use_summary") {
        eventBus.emit("agent.tool.result", {
          phase: tracePhase,
          agentName: traceAgentName,
          toolName: lastToolName,
          success: !("error" in message),
          durationMs: lastToolStartMs > 0 ? Date.now() - lastToolStartMs : 0,
        });
      }
    }

    if (message.type === "result") {
      if (message.subtype === "success") {
        const sessionId = message.session_id ?? "unknown";
        const costUsd = message.total_cost_usd ?? 0;
        const turns = message.num_turns ?? 0;
        const result: QueryResult = {
          result: message.result,
          sessionId,
          cost: costUsd,
          turns,
          structuredOutput: message.structured_output,
        };

        if (eventBus && tracePhase && traceAgentName) {
          eventBus.emit("agent.query.end", {
            phase: tracePhase,
            agentName: traceAgentName,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: costUsd,
            durationMs: Date.now() - startMs,
            success: true,
            label,
            sessionId,
            turns,
          });
        }

        recordQueryTelemetry({
          sessionId,
          label: label ?? traceAgentName,
          phase: telemetryPhase,
          agentName: traceAgentName,
          model: model ?? "unknown",
          costUsd: costUsd,
          turns,
          success: true,
          startedAt: new Date(startMs).toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
        });

        console.log(
          `${tag} success session=${sessionId} turns=${turns} ` +
          `cost=$${costUsd.toFixed(4)} durationMs=${Date.now() - startMs}`
        );

        return result;
      }

      const sessionId = message.session_id ?? "unknown";
      const costUsd = message.total_cost_usd ?? 0;

      if (eventBus && tracePhase && traceAgentName) {
        eventBus.emit("agent.query.end", {
          phase: tracePhase,
          agentName: traceAgentName,
          inputTokens: 0, // token counts unavailable from SDK stream
          outputTokens: 0, // token counts unavailable from SDK stream
          costUsd: costUsd,
          durationMs: Date.now() - startMs,
          success: false,
          label,
          sessionId,
        });
      }

      recordQueryTelemetry({
        sessionId,
        label: label ?? traceAgentName,
        phase: telemetryPhase,
        agentName: traceAgentName,
        model: model ?? "unknown",
        costUsd: costUsd,
        turns: 0,
        success: false,
        startedAt: new Date(startMs).toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - startMs,
      });

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
