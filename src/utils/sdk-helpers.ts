import type { Query, SDKMessage, SDKResultSuccess, SDKResultError, SDKAPIRetryMessage } from "@anthropic-ai/claude-agent-sdk";

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

/**
 * Consume a Query stream and return the final result.
 *
 * Iterates all SDKMessage events, handles errors, logs retries,
 * and extracts the successful result.
 */
export async function consumeQuery(queryStream: Query, label?: string): Promise<QueryResult> {
  const tag = label ? `[${label}]` : "[query]";

  for await (const message of queryStream) {
    switch (message.type) {
      case "result": {
        if (message.subtype === "success") {
          const success = message as SDKResultSuccess;
          return {
            result: success.result,
            sessionId: success.session_id,
            cost: success.total_cost_usd,
            turns: success.num_turns,
            structuredOutput: success.structured_output,
          };
        }

        // Error result
        const error = message as SDKResultError;
        console.error(`${tag} Query error (${error.subtype}): ${error.errors.join("; ")}`);
        throw new QueryExecutionError(error);
      }

      case "system": {
        // Handle API retry messages
        const sysMessage = message as SDKMessage;
        if ("subtype" in sysMessage && sysMessage.subtype === "api_retry") {
          const retry = sysMessage as SDKAPIRetryMessage;
          console.warn(
            `${tag} API retry ${retry.attempt}/${retry.max_retries} ` +
            `(status=${retry.error_status ?? "unknown"}, delay=${retry.retry_delay_ms}ms)`
          );
        }
        break;
      }

      // All other message types (assistant, stream_event, etc.) are informational.
      // We skip them and wait for the result.
      default:
        break;
    }
  }

  // The stream ended without emitting a result message -- this should not
  // happen under normal circumstances but we handle it defensively.
  throw new Error(`${tag} Query stream ended without a result message`);
}
