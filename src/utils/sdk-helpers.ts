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
  /**
   * Per-model token usage from SDKResultSuccess.modelUsage. Keys are model
   * IDs (e.g. "claude-opus-4-6", "claude-sonnet-4-6"). When a lead Opus
   * agent delegates to Sonnet subagents via the Agent tool, both entries
   * appear here so cost can be attributed per model.
   */
  modelUsage?: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    costUSD: number;
  }>;
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
  /**
   * When aborted, consumeQuery calls `queryStream.interrupt()` (if the SDK
   * exposes it) and then throws a `QueryAbortedError`. Used by the orchestrator
   * SIGINT handler to cancel in-flight queries instead of letting them run to
   * completion.
   */
  signal?: AbortSignal | undefined;
}

export class QueryAbortedError extends Error {
  constructor(reason?: string) {
    super(reason ? `Query aborted: ${reason}` : "Query aborted");
    this.name = "QueryAbortedError";
  }
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
  let signal: AbortSignal | undefined;

  if (typeof labelOrOptions === "string") {
    label = labelOrOptions;
  } else if (labelOrOptions) {
    label = labelOrOptions.label;
    onMessage = labelOrOptions.onMessage ?? onMessage;
    eventBus = labelOrOptions.eventBus;
    phase = labelOrOptions.phase;
    agentName = labelOrOptions.agentName;
    model = labelOrOptions.model;
    signal = labelOrOptions.signal;
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

  if (signal?.aborted) {
    throw new QueryAbortedError(signal.reason ? String(signal.reason) : undefined);
  }

  let abortHandler: (() => void) | undefined;
  if (signal) {
    abortHandler = () => {
      const q = queryStream as unknown as { interrupt?: () => Promise<void> };
      if (typeof q.interrupt === "function") {
        q.interrupt().catch(() => {
          /* best-effort interrupt; stream may already be finishing */
        });
      }
    };
    signal.addEventListener("abort", abortHandler, { once: true });
  }

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

  try {
  for await (const message of queryStream) {
    if (signal?.aborted) {
      throw new QueryAbortedError(signal.reason ? String(signal.reason) : undefined);
    }
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
        const usage = (message as unknown as {
          usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
        }).usage;
        const modelUsage = (message as unknown as {
          modelUsage?: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number }>;
        }).modelUsage;

        const result: QueryResult = {
          result: message.result,
          sessionId,
          cost: costUsd,
          turns,
          structuredOutput: message.structured_output,
          ...(modelUsage ? { modelUsage } : {}),
        };

        if (eventBus && tracePhase && traceAgentName) {
          eventBus.emit("agent.query.end", {
            phase: tracePhase,
            agentName: traceAgentName,
            inputTokens: usage?.input_tokens ?? 0,
            outputTokens: usage?.output_tokens ?? 0,
            ...(usage?.cache_read_input_tokens !== undefined ? { cacheReadInputTokens: usage.cache_read_input_tokens } : {}),
            ...(usage?.cache_creation_input_tokens !== undefined ? { cacheCreationInputTokens: usage.cache_creation_input_tokens } : {}),
            ...(modelUsage ? { modelUsage } : {}),
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

  // If the stream ended cleanly because we called interrupt(), surface that
  // as an abort rather than the generic "stream ended" error.
  if (signal?.aborted) {
    throw new QueryAbortedError(signal.reason ? String(signal.reason) : undefined);
  }
  throw new Error(`${tag} Query stream ended without a result message`);
  } finally {
    if (signal && abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
}

/**
 * Compose a system prompt with a stable static prefix suitable for Anthropic
 * prompt caching. The static context (architecture, memory, long instructions)
 * MUST be identical across calls — put it first. Small dynamic details should
 * stay out of this string; pass them in the per-call `prompt` instead.
 *
 * The SDK's `systemPrompt: string` form is sent verbatim to the transport
 * layer, which applies `cache_control: "ephemeral"` automatically. Identical
 * prefixes across calls within ~5 minutes hit the cache.
 */
export function buildCachedSystemPrompt(
  staticContext: string,
  instructions?: string,
): string {
  const prefix = staticContext.trim();
  if (!instructions) return prefix;
  const suffix = instructions.trim();
  return suffix.length === 0 ? prefix : `${prefix}\n\n${suffix}`;
}

// --- Query permissions from config ---

import { MAX_TURNS_DEFAULTS, type Config } from "./config.js";

export interface QueryPermissions {
  permissionMode: "acceptEdits" | "bypassPermissions" | "default";
  allowDangerouslySkipPermissions: boolean;
}

// Autonomous mode uses `acceptEdits` rather than `bypassPermissions`.
//
// Why: `bypassPermissions` (whether set via the mode flag OR via
// --dangerously-skip-permissions) is refused by the Claude Code CLI when
// running as root — a common case in Docker/sandboxed environments. This
// made the entire system unusable inside containers.
//
// `acceptEdits` auto-approves Edit/Write/Bash tool calls in non-interactive
// (-p) mode the same way bypass did for our use case, but works under root
// since it doesn't require the dangerous flag. Verified with:
//   claude -p "..." --permission-mode acceptEdits → exit 0 under root.
const BYPASS_PERMISSIONS: QueryPermissions = { permissionMode: "acceptEdits", allowDangerouslySkipPermissions: false };
const DEFAULT_PERMISSIONS: QueryPermissions = { permissionMode: "default", allowDangerouslySkipPermissions: false };

export function getQueryPermissions(config?: Config): QueryPermissions {
  return (!config || config.autonomousMode) ? BYPASS_PERMISSIONS : DEFAULT_PERMISSIONS;
}

// --- Max turns from config ---

export type MaxTurnsKey = keyof Config["maxTurns"];

export function getMaxTurns(config: Config | undefined, key: MaxTurnsKey): number {
  return config?.maxTurns?.[key] ?? MAX_TURNS_DEFAULTS[key];
}
