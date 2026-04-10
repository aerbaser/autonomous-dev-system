import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumeQuery,
  QueryExecutionError,
  getQueryPermissions,
  getMaxTurns,
} from "../../src/utils/sdk-helpers.js";
import type { Config } from "../../src/utils/config.js";
import { MAX_TURNS_DEFAULTS } from "../../src/utils/config.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

type FakeMessage =
  | { type: "result"; subtype: "success"; result: string; session_id: string; total_cost_usd: number; num_turns: number; structured_output?: unknown }
  | { type: "result"; subtype: "error_max_turns"; errors: string[]; session_id: string; total_cost_usd: number }
  | { type: "system"; subtype: "api_retry_started"; attempt: number; max_retries: number; error_status?: number; retry_delay_ms: number };

function makeQueryStream(...messages: FakeMessage[]) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i >= messages.length) return { value: undefined, done: true as const };
          return { value: messages[i++], done: false as const };
        },
      };
    },
    close() {},
  } as any;
}

function makeSuccessStream(resultText = "ok", cost = 0.01, structuredOutput?: unknown) {
  return makeQueryStream({
    type: "result",
    subtype: "success",
    result: resultText,
    session_id: "test-session",
    total_cost_usd: cost,
    num_turns: 1,
    structured_output: structuredOutput,
  });
}

function makeErrorStream(subtype: "error_max_turns" | "error_during_execution" = "error_max_turns", errors = ["something failed"]) {
  return makeQueryStream({
    type: "result",
    subtype: subtype as any,
    errors,
    session_id: "test-err-session",
    total_cost_usd: 0.005,
  } as any);
}

// ── consumeQuery ──────────────────────────────────────────────────────────────

describe("consumeQuery", () => {
  it("returns result, sessionId, cost, turns on success", async () => {
    const result = await consumeQuery(makeSuccessStream("hello world", 0.02), "test-label");

    expect(result.result).toBe("hello world");
    expect(result.sessionId).toBe("test-session");
    expect(result.cost).toBe(0.02);
    expect(result.turns).toBe(1);
  });

  it("returns structuredOutput when present", async () => {
    const structured = { foo: "bar" };
    const result = await consumeQuery(makeSuccessStream("text", 0.01, structured));
    expect(result.structuredOutput).toEqual(structured);
  });

  it("returns undefined structuredOutput when absent", async () => {
    const result = await consumeQuery(makeSuccessStream("text"));
    expect(result.structuredOutput).toBeUndefined();
  });

  it("throws QueryExecutionError on error result", async () => {
    await expect(
      consumeQuery(makeErrorStream("error_max_turns", ["max turns reached"]))
    ).rejects.toBeInstanceOf(QueryExecutionError);
  });

  it("QueryExecutionError carries errors array and subtype", async () => {
    let caught: QueryExecutionError | undefined;
    try {
      await consumeQuery(makeErrorStream("error_max_turns" as any, ["limit exceeded"]));
    } catch (e) {
      caught = e as QueryExecutionError;
    }

    expect(caught).toBeDefined();
    expect(caught!.errors).toContain("limit exceeded");
    expect(caught!.subtype).toBe("error_max_turns");
    expect(caught!.sessionId).toBe("test-err-session");
    expect(caught!.cost).toBe(0.005);
  });

  it("throws when stream ends without result message", async () => {
    const emptyStream = makeQueryStream();
    await expect(consumeQuery(emptyStream)).rejects.toThrow(/without a result message/);
  });

  it("accepts options object with label and onMessage", async () => {
    const messages: unknown[] = [];
    const result = await consumeQuery(makeSuccessStream("data"), {
      label: "my-label",
      onMessage: (msg) => messages.push(msg),
    });

    expect(result.result).toBe("data");
    expect(messages.length).toBeGreaterThan(0);
  });

  it("accepts legacy signature (stream, label, onMessage)", async () => {
    const messages: unknown[] = [];
    const result = await consumeQuery(
      makeSuccessStream("legacy"),
      "legacy-label",
      (msg) => messages.push(msg)
    );

    expect(result.result).toBe("legacy");
    expect(messages.length).toBeGreaterThan(0);
  });

  it("persists query telemetry into the active .autonomous-dev directory", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "sdk-helpers-telemetry-"));
    const stateDir = join(rootDir, ".autonomous-dev");
    mkdirSync(stateDir, { recursive: true });

    const previousCwd = process.cwd();
    process.chdir(rootDir);

    try {
      const result = await consumeQuery(makeSuccessStream("persisted", 0.03), "ideation");
      expect(result.result).toBe("persisted");

      const telemetryPath = join(stateDir, "query-sessions.json");
      expect(existsSync(telemetryPath)).toBe(true);

      const parsed = JSON.parse(readFileSync(telemetryPath, "utf-8")) as any;
      expect(parsed.queries["test-session"]?.label).toBe("ideation");
      expect(parsed.queries["test-session"]?.success).toBe(true);
      expect(parsed.queries["test-session"]?.turns).toBe(1);
    } finally {
      process.chdir(previousCwd);
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("emits enriched query events when an event bus is provided", async () => {
    const emitted: Array<{ type: string; data: any }> = [];
    const eventBus = {
      emit(type: string, data: any) {
        emitted.push({ type, data });
        return { type, data };
      },
    } as any;

    const result = await consumeQuery(makeSuccessStream("eventful", 0.04), {
      label: "ideation",
      phase: "ideation",
      agentName: "spec-writer",
      model: "sonnet",
      eventBus,
    });

    expect(result.result).toBe("eventful");

    const start = emitted.find((event) => event.type === "agent.query.start");
    const end = emitted.find((event) => event.type === "agent.query.end");

    expect(start?.data.label).toBe("ideation");
    expect(start?.data.agentName).toBe("spec-writer");
    expect(end?.data.sessionId).toBe("test-session");
    expect(end?.data.turns).toBe(1);
    expect(end?.data.label).toBe("ideation");
  });

  it("infers phase from a phase-shaped label for legacy call sites", async () => {
    const emitted: Array<{ type: string; data: any }> = [];
    const eventBus = {
      emit(type: string, data: any) {
        emitted.push({ type, data });
        return { type, data };
      },
    } as any;

    await consumeQuery(makeSuccessStream("legacy-phase", 0.01), {
      label: "architecture",
      agentName: "architect",
      eventBus,
    });

    const start = emitted.find((event) => event.type === "agent.query.start");
    expect(start?.data.phase).toBe("architecture");
    expect(start?.data.label).toBe("architecture");
  });
});

// ── getQueryPermissions ───────────────────────────────────────────────────────

describe("getQueryPermissions", () => {
  it("returns bypass permissions when config is undefined", () => {
    const perms = getQueryPermissions(undefined);
    expect(perms.permissionMode).toBe("bypassPermissions");
    expect(perms.allowDangerouslySkipPermissions).toBe(true);
  });

  it("returns bypass permissions when autonomousMode is true", () => {
    const config = { autonomousMode: true } as Config;
    const perms = getQueryPermissions(config);
    expect(perms.permissionMode).toBe("bypassPermissions");
  });

  it("returns default permissions when autonomousMode is false", () => {
    const config = { autonomousMode: false } as Config;
    const perms = getQueryPermissions(config);
    expect(perms.permissionMode).toBe("default");
    expect(perms.allowDangerouslySkipPermissions).toBe(false);
  });
});

// ── getMaxTurns ───────────────────────────────────────────────────────────────

describe("getMaxTurns", () => {
  it("returns default when config is undefined", () => {
    expect(getMaxTurns(undefined, "ideation")).toBe(MAX_TURNS_DEFAULTS.ideation);
    expect(getMaxTurns(undefined, "development")).toBe(MAX_TURNS_DEFAULTS.development);
  });

  it("returns default when config.maxTurns is not set", () => {
    const config = {} as Config;
    expect(getMaxTurns(config, "testing")).toBe(MAX_TURNS_DEFAULTS.testing);
  });

  it("returns config value when maxTurns is configured", () => {
    const config = { maxTurns: { ...MAX_TURNS_DEFAULTS, ideation: 99 } } as Config;
    expect(getMaxTurns(config, "ideation")).toBe(99);
  });

  it("returns defaults for all standard phase keys", () => {
    const keys = Object.keys(MAX_TURNS_DEFAULTS) as Array<keyof typeof MAX_TURNS_DEFAULTS>;
    for (const key of keys) {
      expect(getMaxTurns(undefined, key)).toBe(MAX_TURNS_DEFAULTS[key]);
    }
  });
});
