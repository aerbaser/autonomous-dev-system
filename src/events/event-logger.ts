import { createWriteStream, mkdirSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { WriteStream } from "node:fs";
import type { EventRecord } from "./event-bus.js";

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

  constructor(
    stateDir: string,
    private runId: string,
  ) {
    const eventsDir = resolve(stateDir, "events");
    mkdirSync(eventsDir, { recursive: true });
    this.logPath = resolve(eventsDir, `${runId}.jsonl`);
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
        const data = event.data as {
          inputTokens: number;
          outputTokens: number;
          costUsd: number;
        };
        totalInput += data.inputTokens;
        totalOutput += data.outputTokens;
        totalCostUsd += data.costUsd;
      }

      if (event.type === "orchestrator.phase.end") {
        const data = event.data as {
          phase: string;
          durationMs: number;
          success: boolean;
          costUsd?: number;
        };
        phases.push({
          name: data.phase,
          durationMs: data.durationMs,
          success: data.success,
          costUsd: data.costUsd ?? 0,
        });
      }

      if (event.type === "agent.tool.result") {
        const data = event.data as {
          toolName: string;
          durationMs: number;
        };
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

  private readEvents(): EventRecord[] {
    if (!existsSync(this.logPath)) return [];

    const content = readFileSync(this.logPath, "utf-8").trim();
    if (!content) return [];

    return content.split("\n").map((line) => JSON.parse(line) as EventRecord);
  }
}
