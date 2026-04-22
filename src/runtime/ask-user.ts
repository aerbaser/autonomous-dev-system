import { z } from "zod";
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface as defaultCreateInterface, type Interface as ReadlineInterface } from "node:readline/promises";
import { assertSafePath, assertSafeWritePath } from "../state/project-state.js";
import { errMsg } from "../utils/shared.js";

/**
 * Schema for entries written to `{stateDir}/pending-questions.jsonl`.
 * Captures skipped / timed-out user clarifications so operators can audit
 * what the autonomous run didn't get to ask.
 */
export const AskUserRecordSchema = z.object({
  timestamp: z.string(),
  question: z.string(),
  defaultValue: z.string(),
  resolution: z.enum([
    "skipped-non-interactive",
    "skipped-flag-off",
    "timeout",
    "answered",
    "default-empty",
  ]),
});
export type AskUserRecord = z.infer<typeof AskUserRecordSchema>;

export interface AskUserOptions {
  defaultValue: string;
  timeoutMs?: number;
}

export interface AskUserResult {
  answer: string;
  source: "user" | "default" | "timeout";
}

/**
 * DI hook for tests: allow injecting a fake readline factory so we can simulate
 * TTY interaction without touching real stdin. Production callers should use
 * the default (omit this field).
 */
export interface AskUserConfig {
  allowAskUser: boolean;
  stateDir: string;
  readlineFactory?: () => ReadlineInterface;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function appendRecord(stateDir: string, record: AskUserRecord): void {
  assertSafePath(stateDir);
  const path = resolve(stateDir, "pending-questions.jsonl");
  // SEC-07: pin journal path inside stateDir before mkdir/append.
  assertSafeWritePath(stateDir, path);
  try {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(path, JSON.stringify(record) + "\n", "utf-8");
  } catch (err) {
    // Non-fatal: the caller still gets a default answer.
    console.warn(`[ask-user] Failed to append to ${path}: ${errMsg(err)}`);
  }
}

/**
 * Prompt the user for a clarification. Gated behind `config.allowAskUser` AND
 * process.stdin.isTTY — any other state returns the default and journals a
 * skip record. See AskUserRecordSchema for the journal shape.
 */
export async function promptUser(
  question: string,
  options: AskUserOptions,
  config: AskUserConfig,
): Promise<AskUserResult> {
  const defaultValue = options.defaultValue;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Skip path: flag off.
  if (!config.allowAskUser) {
    appendRecord(config.stateDir, {
      timestamp: new Date().toISOString(),
      question,
      defaultValue,
      resolution: "skipped-flag-off",
    });
    return { answer: defaultValue, source: "default" };
  }

  // Skip path: non-interactive shell (e.g. CI / piped stdin).
  if (!process.stdin.isTTY) {
    appendRecord(config.stateDir, {
      timestamp: new Date().toISOString(),
      question,
      defaultValue,
      resolution: "skipped-non-interactive",
    });
    return { answer: defaultValue, source: "default" };
  }

  // Interactive path.
  const factory = config.readlineFactory
    ?? (() => defaultCreateInterface({ input: process.stdin, output: process.stdout }));
  const rl = factory();

  const prompt = `[?] ${question}\n(default: ${defaultValue}): `;

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const answerPromise = rl.question(prompt);
    const timeoutPromise = new Promise<"__TIMEOUT__">((resolvePromise) => {
      timer = setTimeout(() => resolvePromise("__TIMEOUT__"), timeoutMs);
    });

    const raced = await Promise.race([answerPromise, timeoutPromise]);

    if (raced === "__TIMEOUT__") {
      appendRecord(config.stateDir, {
        timestamp: new Date().toISOString(),
        question,
        defaultValue,
        resolution: "timeout",
      });
      return { answer: defaultValue, source: "timeout" };
    }

    const trimmed = raced.trim();
    if (trimmed === "") {
      appendRecord(config.stateDir, {
        timestamp: new Date().toISOString(),
        question,
        defaultValue,
        resolution: "default-empty",
      });
      return { answer: defaultValue, source: "default" };
    }

    appendRecord(config.stateDir, {
      timestamp: new Date().toISOString(),
      question,
      defaultValue,
      resolution: "answered",
    });
    return { answer: trimmed, source: "user" };
  } finally {
    if (timer !== null) clearTimeout(timer);
    try {
      rl.close();
    } catch {
      // ignore — close errors are non-fatal
    }
  }
}
