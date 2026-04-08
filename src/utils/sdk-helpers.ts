import type { Query, SDKMessage, SDKResultError } from "@anthropic-ai/claude-agent-sdk";

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

export async function consumeQuery(queryStream: Query, label?: string): Promise<QueryResult> {
  const tag = label ? `[${label}]` : "[query]";

  for await (const message of queryStream) {
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

function isApiRetry(
  message: SDKMessage
): message is Extract<SDKMessage, { subtype: "api_retry" }> {
  return (
    message.type === "system" &&
    "subtype" in message &&
    (message as Record<string, unknown>).subtype === "api_retry"
  );
}
