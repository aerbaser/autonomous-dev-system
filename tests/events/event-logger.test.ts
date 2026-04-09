import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLogger } from "../../src/events/event-logger.js";
import type { EventRecord } from "../../src/events/event-bus.js";

describe("EventLogger", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "event-logger-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeRecord(type: string, seq: number, data: unknown): EventRecord {
    return {
      type: type as EventRecord["type"],
      timestamp: new Date().toISOString(),
      seq,
      data,
    };
  }

  it("writes events as JSONL", async () => {
    const logger = new EventLogger(tempDir, "test-run-1");

    await logger.log(makeRecord("orchestrator.phase.start", 0, { phase: "ideation" }));
    await logger.log(makeRecord("orchestrator.phase.end", 1, { phase: "ideation", success: true, durationMs: 500 }));
    await logger.close();

    const content = readFileSync(logger.getLogPath(), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);

    const parsed0 = JSON.parse(lines[0]!) as EventRecord;
    expect(parsed0.type).toBe("orchestrator.phase.start");
    expect(parsed0.seq).toBe(0);

    const parsed1 = JSON.parse(lines[1]!) as EventRecord;
    expect(parsed1.type).toBe("orchestrator.phase.end");
  });

  it("appends to existing file", async () => {
    const logger = new EventLogger(tempDir, "test-run-2");

    await logger.log(makeRecord("orchestrator.phase.start", 0, { phase: "ideation" }));
    await logger.close();

    // Reopen and append
    const logger2 = new EventLogger(tempDir, "test-run-2");
    await logger2.log(makeRecord("orchestrator.phase.end", 1, { phase: "ideation", success: true, durationMs: 100 }));
    await logger2.close();

    const content = readFileSync(logger.getLogPath(), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("generates run summary with token and cost aggregation", async () => {
    const logger = new EventLogger(tempDir, "summary-run");

    await logger.log(makeRecord("agent.query.end", 0, {
      phase: "ideation",
      agentName: "ideation-agent",
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.05,
      durationMs: 2000,
      success: true,
    }));
    await logger.log(makeRecord("agent.query.end", 1, {
      phase: "development",
      agentName: "dev-agent",
      inputTokens: 2000,
      outputTokens: 1000,
      costUsd: 0.10,
      durationMs: 5000,
      success: true,
    }));
    await logger.log(makeRecord("orchestrator.phase.end", 2, {
      phase: "ideation",
      success: true,
      costUsd: 0.05,
      durationMs: 3000,
    }));
    await logger.log(makeRecord("agent.tool.result", 3, {
      phase: "development",
      agentName: "dev-agent",
      toolName: "Bash",
      success: true,
      durationMs: 100,
    }));
    await logger.log(makeRecord("agent.tool.result", 4, {
      phase: "development",
      agentName: "dev-agent",
      toolName: "Bash",
      success: true,
      durationMs: 200,
    }));
    await logger.log(makeRecord("agent.tool.result", 5, {
      phase: "development",
      agentName: "dev-agent",
      toolName: "Read",
      success: true,
      durationMs: 50,
    }));
    await logger.close();

    const summary = await logger.generateRunSummary();

    expect(summary.runId).toBe("summary-run");
    expect(summary.totalTokens.input).toBe(3000);
    expect(summary.totalTokens.output).toBe(1500);
    expect(summary.totalCostUsd).toBeCloseTo(0.15);
    expect(summary.phases).toHaveLength(1);
    expect(summary.phases[0]!.name).toBe("ideation");
    expect(summary.phases[0]!.costUsd).toBe(0.05);
    expect(summary.toolUsage["Bash"]!.count).toBe(2);
    expect(summary.toolUsage["Bash"]!.totalDurationMs).toBe(300);
    expect(summary.toolUsage["Read"]!.count).toBe(1);
  });

  it("generates empty summary for empty log", async () => {
    const logger = new EventLogger(tempDir, "empty-run");
    const summary = await logger.generateRunSummary();

    expect(summary.totalTokens.input).toBe(0);
    expect(summary.totalTokens.output).toBe(0);
    expect(summary.totalCostUsd).toBe(0);
    expect(summary.phases).toHaveLength(0);
  });

  it("creates events directory if it does not exist", async () => {
    const nestedDir = join(tempDir, "nested", "state");
    const logger = new EventLogger(nestedDir, "nested-run");

    await logger.log(makeRecord("orchestrator.phase.start", 0, { phase: "ideation" }));
    await logger.close();

    const content = readFileSync(logger.getLogPath(), "utf-8");
    expect(content.trim()).toBeTruthy();
  });

  it("close is idempotent", async () => {
    const logger = new EventLogger(tempDir, "close-test");
    await logger.log(makeRecord("orchestrator.phase.start", 0, { phase: "ideation" }));

    await logger.close();
    await logger.close(); // Should not throw
  });
});
