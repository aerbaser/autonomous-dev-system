import { createWriteStream, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { WriteStream } from "node:fs";
import type { EventRecord } from "./event-bus.js";
import { isRecord } from "../utils/shared.js";
import { z } from "zod";

const AgentQueryEndDataSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number(),
});

const OrchestratorPhaseEndDataSchema = z.object({
  phase: z.string(),
  durationMs: z.number(),
  success: z.boolean(),
  costUsd: z.number().optional(),
});

const AgentToolResultDataSchema = z.object({
  toolName: z.string(),
  durationMs: z.number(),
});

export interface RunSummary {
  runId: string;
  startedAt: string;
  endedAt: string;
  totalTokens: { input: number; output: number };
  totalCostUsd: number;
  phases: { name: string; durationMs: number; success: boolean; costUsd: number }[];
  toolUsage: Record<string, { count: number; totalDurationMs: number }>;
}

export class EventLogger {
  private stream: WriteStream | null = null;
  private logPath: string;
  private summaryPath: string;

  constructor(
    stateDir: string,
    private runId: string,
  ) {
    const eventsDir = resolve(stateDir, "events");
    mkdirSync(eventsDir, { recursive: true });
    this.logPath = resolve(eventsDir, `${runId}.jsonl`);
    this.summaryPath = resolve(eventsDir, `${runId}.summary.json`);
  }

  async log(record: EventRecord): Promise<void> {
    if (!this.stream) {
      this.stream = createWriteStream(this.logPath, { flags: "a" });
    }

    const line = JSON.stringify(record) + "\n";

    return new Promise((resolve, reject) => {
      this.stream!.write(line, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async generateRunSummary(): Promise<RunSummary> {
    const events = this.readEvents();

    let startedAt = "";
    let endedAt = "";
    let totalInput = 0;
    let totalOutput = 0;
    let totalCostUsd = 0;
    const phases: RunSummary["phases"] = [];
    const toolUsage: RunSummary["toolUsage"] = {};

    if (events.length > 0) {
      startedAt = events[0]!.timestamp;
      endedAt = events[events.length - 1]!.timestamp;
    }

    for (const event of events) {
      if (event.type === "agent.query.end") {
        const parsed = AgentQueryEndDataSchema.safeParse(event.data);
        if (!parsed.success) continue;
        const data = parsed.data;
        totalInput += data.inputTokens;
        totalOutput += data.outputTokens;
        totalCostUsd += data.costUsd;
      }

      if (event.type === "orchestrator.phase.end") {
        const parsed = OrchestratorPhaseEndDataSchema.safeParse(event.data);
        if (!parsed.success) continue;
        const data = parsed.data;
        phases.push({
          name: data.phase,
          durationMs: data.durationMs,
          success: data.success,
          costUsd: data.costUsd ?? 0,
        });
      }

      if (event.type === "agent.tool.result") {
        const parsed = AgentToolResultDataSchema.safeParse(event.data);
        if (!parsed.success) continue;
        const data = parsed.data;
        const existing = toolUsage[data.toolName];
        if (!existing) {
          toolUsage[data.toolName] = { count: 1, totalDurationMs: data.durationMs };
        } else {
          existing.count++;
          existing.totalDurationMs += data.durationMs;
        }
      }
    }

    return {
      runId: this.runId,
      startedAt,
      endedAt,
      totalTokens: { input: totalInput, output: totalOutput },
      totalCostUsd,
      phases,
      toolUsage,
    };
  }

  async persistRunSummary(): Promise<string> {
    const summary = await this.generateRunSummary();
    writeFileSync(this.summaryPath, JSON.stringify(summary, null, 2), "utf8");
    return this.summaryPath;
  }

  async close(): Promise<void> {
    if (this.stream) {
      return new Promise((resolve) => {
        this.stream!.end(() => {
          this.stream = null;
          resolve();
        });
      });
    }
  }

  getLogPath(): string {
    return this.logPath;
  }

  getSummaryPath(): string {
    return this.summaryPath;
  }

  private readEvents(): EventRecord[] {
    if (!existsSync(this.logPath)) return [];

    const content = readFileSync(this.logPath, "utf-8").trim();
    if (!content) return [];

    return content.split("\n")
      .map((line) => { try { return JSON.parse(line) as unknown; } catch { return null; } })
      .filter((r): r is EventRecord => isRecord(r) && typeof r["seq"] === "number" && typeof r["type"] === "string")
      .sort((a, b) => a.seq - b.seq);
  }
}
