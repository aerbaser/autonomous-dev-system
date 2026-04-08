import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null;
}

export function isApiRetry(
  message: SDKMessage
): message is Extract<SDKMessage, { subtype: "api_retry" }> {
  if (message.type !== "system" || !("subtype" in message)) return false;
  const record: Record<string, unknown> = message;
  return record.subtype === "api_retry";
}

/** Extract the first balanced JSON object from text, correctly handling strings with braces. */
export function extractFirstJson(text: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        const candidate = text.slice(start, i + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          start = -1;
        }
      }
    }
  }

  return null;
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Wrap user-derived content in XML delimiters to prevent prompt injection. */
export function wrapUserInput(tag: string, content: string): string {
  return `<${tag}>\n${content}\n</${tag}>`;
}
