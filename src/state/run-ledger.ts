import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Phase } from "../types/phases.js";
import type { EventBus, EventRecord, AgentQueryStartData, AgentQueryEndData } from "../events/event-bus.js";
import { assertSafePath } from "./project-state.js";
import { errMsg } from "../utils/shared.js";

export const SessionTypeSchema = z.enum([
  "coordinator",
  "team_lead",
  "child_agent",
  "subagent",
  "rubric",
  "memory",
  "retry",
]);
export type SessionType = z.infer<typeof SessionTypeSchema>;

export const ReasonCodeSchema = z.enum([
  "provider_limit",
  "provider_rate_limit",
  "invalid_structured_output",
  "verification_failed",
  "blocked_filesystem",
  "unsupported_team_runtime",
]);
export type ReasonCode = z.infer<typeof ReasonCodeSchema>;

export const SessionAttributionSchema = z.object({
  sessionId: z.string(),
  phase: z.string(),
  role: z.string(),
  taskId: z.string().optional(),
  sessionType: SessionTypeSchema,
  parentSessionId: z.string().optional(),
  model: z.string().optional(),
});
export type SessionAttribution = z.infer<typeof SessionAttributionSchema>;

export const SessionSpendSchema = z.object({
  costUsd: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
});
export type SessionSpend = z.infer<typeof SessionSpendSchema>;

export const SessionFailureSchema = z.object({
  reasonCode: ReasonCodeSchema,
  message: z.string(),
  at: z.string(),
});
export type SessionFailure = z.infer<typeof SessionFailureSchema>;

export const SessionRecordSchema = z.object({
  sessionId: z.string(),
  phase: z.string(),
  role: z.string(),
  taskId: z.string().optional(),
  sessionType: SessionTypeSchema,
  parentSessionId: z.string().optional(),
  model: z.string().optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  durationMs: z.number().optional(),
  success: z.boolean().optional(),
  spend: SessionSpendSchema,
  failures: z.array(SessionFailureSchema),
});
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

// Zod v4 `z.record(enum, v)` requires all enum keys present; we want a sparse
// map (only observed types/reasons appear). Use string keys + a post-parse
// refine that every key belongs to the enum.
const SpendByTypeSchema = z.record(z.string(), z.object({
  sessions: z.number(),
  costUsd: z.number(),
})).refine(
  (rec) => Object.keys(rec).every((k) => SessionTypeSchema.safeParse(k).success),
  { message: "byType contains invalid SessionType key" },
);

const FailuresByReasonSchema = z.record(z.string(), z.number()).refine(
  (rec) => Object.keys(rec).every((k) => ReasonCodeSchema.safeParse(k).success),
  { message: "failuresByReason contains invalid ReasonCode key" },
);

export const RunLedgerSnapshotSchema = z.object({
  runId: z.string(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  sessions: z.array(SessionRecordSchema),
  aggregates: z.object({
    totalCostUsd: z.number(),
    totalInputTokens: z.number(),
    totalOutputTokens: z.number(),
    totalCacheReadTokens: z.number(),
    totalCacheWriteTokens: z.number(),
    byType: SpendByTypeSchema,
    failuresByReason: FailuresByReasonSchema,
  }),
});
export type RunLedgerSnapshot = z.infer<typeof RunLedgerSnapshotSchema>;

export interface StartSessionInput {
  sessionId?: string;
  phase: Phase | string;
  role: string;
  sessionType: SessionType;
  taskId?: string;
  parentSessionId?: string;
  model?: string;
}

// Singleton for weakly-coupled event-bus integration. Orchestrator sets this
// when a run starts; consumers (event-bus bridge) read through getActiveLedger.
let activeLedger: RunLedger | null = null;

export function getActiveLedger(): RunLedger | null {
  return activeLedger;
}

export function setActiveLedger(ledger: RunLedger | null): void {
  activeLedger = ledger;
}

function emptySpend(): SessionSpend {
  return {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

export class RunLedger {
  readonly runId: string;
  readonly startedAt: string;
  private endedAt: string | undefined;
  private sessions = new Map<string, SessionRecord>();
  // Used to correlate AgentQueryStart → AgentQueryEnd when the caller didn't
  // explicitly register a session via startSession (e.g. inside consumeQuery).
  private autoKey = new Map<string, string>();
  private unsubBus: (() => void) | undefined;

  constructor(runId?: string) {
    this.runId = runId ?? randomUUID();
    this.startedAt = new Date().toISOString();
  }

  startSession(input: StartSessionInput): SessionRecord {
    const sessionId = input.sessionId ?? randomUUID();
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const record: SessionRecord = {
      sessionId,
      phase: input.phase,
      role: input.role,
      sessionType: input.sessionType,
      startedAt: new Date().toISOString(),
      spend: emptySpend(),
      failures: [],
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.parentSessionId !== undefined ? { parentSessionId: input.parentSessionId } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
    };
    this.sessions.set(sessionId, record);
    return record;
  }

  endSession(
    sessionId: string,
    outcome: { success: boolean; spend?: Partial<SessionSpend>; durationMs?: number },
  ): SessionRecord | null {
    const record = this.sessions.get(sessionId);
    if (!record) return null;
    record.endedAt = new Date().toISOString();
    record.success = outcome.success;
    if (outcome.durationMs !== undefined) record.durationMs = outcome.durationMs;
    if (outcome.spend) this.mergeSpend(record, outcome.spend);
    return record;
  }

  recordFailure(sessionId: string, reasonCode: ReasonCode, message: string): SessionRecord | null {
    const record = this.sessions.get(sessionId);
    if (!record) return null;
    record.failures.push({
      reasonCode,
      message,
      at: new Date().toISOString(),
    });
    record.success = false;
    return record;
  }

  // Bridge AgentQueryStart/End events → session lifecycle. Intended for weak
  // coupling: orchestrator calls this once per run and the bus drives the
  // ledger without leaking the ledger into every callsite.
  attachEventBus(bus: EventBus): () => void {
    const offStart = bus.on("agent.query.start", (record: EventRecord<AgentQueryStartData>) => {
      try {
        this.onQueryStart(record.data);
      } catch (err) {
        console.warn(`[run-ledger] failed to handle agent.query.start: ${errMsg(err)}`);
      }
    });
    const offEnd = bus.on("agent.query.end", (record: EventRecord<AgentQueryEndData>) => {
      try {
        this.onQueryEnd(record.data);
      } catch (err) {
        console.warn(`[run-ledger] failed to handle agent.query.end: ${errMsg(err)}`);
      }
    });
    const composite = () => {
      offStart();
      offEnd();
    };
    this.unsubBus = composite;
    return composite;
  }

  private onQueryStart(data: AgentQueryStartData): void {
    const key = this.autoSessionKey(data.phase, data.agentName);
    // Only auto-create when no explicitly-registered session matches this key.
    // Keeps explicit startSession callers authoritative.
    if (this.autoKey.has(key)) return;
    const sessionId = randomUUID();
    this.autoKey.set(key, sessionId);
    this.startSession({
      sessionId,
      phase: data.phase,
      role: data.agentName,
      sessionType: inferSessionType(data.agentName),
      model: data.model,
    });
  }

  private onQueryEnd(data: AgentQueryEndData): void {
    const key = this.autoSessionKey(data.phase, data.agentName);
    const sessionId = this.autoKey.get(key);
    if (!sessionId) return;
    this.autoKey.delete(key);
    const spend: Partial<SessionSpend> = {
      costUsd: data.costUsd,
      inputTokens: data.inputTokens,
      outputTokens: data.outputTokens,
      // Cache-token fields are forward-compatible: events may carry them
      // even if AgentQueryEndData doesn't yet declare them as typed fields.
      cacheReadTokens: (data as { cacheReadInputTokens?: number }).cacheReadInputTokens ?? 0,
      cacheWriteTokens: (data as { cacheCreationInputTokens?: number }).cacheCreationInputTokens ?? 0,
    };
    this.endSession(sessionId, {
      success: data.success,
      spend,
      durationMs: data.durationMs,
    });
  }

  private autoSessionKey(phase: string, agentName: string): string {
    return `${phase}::${agentName}`;
  }

  private mergeSpend(record: SessionRecord, add: Partial<SessionSpend>): void {
    if (add.costUsd !== undefined) record.spend.costUsd += add.costUsd;
    if (add.inputTokens !== undefined) record.spend.inputTokens += add.inputTokens;
    if (add.outputTokens !== undefined) record.spend.outputTokens += add.outputTokens;
    if (add.cacheReadTokens !== undefined) record.spend.cacheReadTokens += add.cacheReadTokens;
    if (add.cacheWriteTokens !== undefined) record.spend.cacheWriteTokens += add.cacheWriteTokens;
  }

  snapshot(): RunLedgerSnapshot {
    const sessions = Array.from(this.sessions.values()).map((s) => ({
      ...s,
      failures: [...s.failures],
      spend: { ...s.spend },
    }));
    const aggregates = {
      totalCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      byType: {} as Record<SessionType, { sessions: number; costUsd: number }>,
      failuresByReason: {} as Record<ReasonCode, number>,
    };

    for (const s of sessions) {
      aggregates.totalCostUsd += s.spend.costUsd;
      aggregates.totalInputTokens += s.spend.inputTokens;
      aggregates.totalOutputTokens += s.spend.outputTokens;
      aggregates.totalCacheReadTokens += s.spend.cacheReadTokens;
      aggregates.totalCacheWriteTokens += s.spend.cacheWriteTokens;
      const bucket = aggregates.byType[s.sessionType] ?? { sessions: 0, costUsd: 0 };
      bucket.sessions += 1;
      bucket.costUsd += s.spend.costUsd;
      aggregates.byType[s.sessionType] = bucket;
      for (const f of s.failures) {
        aggregates.failuresByReason[f.reasonCode] =
          (aggregates.failuresByReason[f.reasonCode] ?? 0) + 1;
      }
    }

    return {
      runId: this.runId,
      startedAt: this.startedAt,
      ...(this.endedAt !== undefined ? { endedAt: this.endedAt } : {}),
      sessions,
      aggregates,
    };
  }

  persist(stateDir: string): string {
    assertSafePath(stateDir);
    this.endedAt = this.endedAt ?? new Date().toISOString();
    const ledgerDir = resolve(stateDir, "ledger");
    mkdirSync(ledgerDir, { recursive: true });
    const snap = this.snapshot();
    const path = resolve(ledgerDir, `${this.runId}.json`);
    writeFileSync(path, JSON.stringify(snap, null, 2));
    return path;
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): SessionRecord[] {
    return Array.from(this.sessions.values());
  }

  dispose(): void {
    if (this.unsubBus) {
      this.unsubBus();
      this.unsubBus = undefined;
    }
    if (activeLedger === this) activeLedger = null;
  }

  /**
   * Phase 3: split run spend into coordination (supervisory agents that only
   * delegate) vs. implementation (agents that actually change code / produce
   * artifacts). Useful for run reports to expose how much budget was burned
   * on orchestration overhead — the exact thing the execution-plan wants to
   * squeeze out of the default dev path.
   *
   * Classification is derived from `SessionType`:
   *   coordination  = coordinator | team_lead | retry
   *   implementation = child_agent | subagent
   * `rubric` / `memory` are observational/auxiliary and counted as neither —
   * they have their own buckets in `byType` so run reports can surface them
   * separately without double-counting.
   */
  coordinationVsImplementation(): {
    coordinationUsd: number;
    implementationUsd: number;
    auxiliaryUsd: number;
    ratio: number;
  } {
    let coord = 0;
    let impl = 0;
    let aux = 0;
    for (const s of this.sessions.values()) {
      const cost = s.spend.costUsd;
      if (cost <= 0) continue;
      switch (s.sessionType) {
        case "coordinator":
        case "team_lead":
        case "retry":
          coord += cost;
          break;
        case "child_agent":
        case "subagent":
          impl += cost;
          break;
        case "rubric":
        case "memory":
          aux += cost;
          break;
      }
    }
    // Ratio expresses coordination cost as a fraction of coordination +
    // implementation (ignoring auxiliary so rubric/memory noise doesn't
    // dilute the signal). Falls back to 0 on empty runs.
    const denom = coord + impl;
    const ratio = denom > 0 ? coord / denom : 0;
    return { coordinationUsd: coord, implementationUsd: impl, auxiliaryUsd: aux, ratio };
  }
}

export function loadLedger(stateDir: string, runId: string): RunLedgerSnapshot | null {
  assertSafePath(stateDir);
  const path = resolve(stateDir, "ledger", `${runId}.json`);
  if (!existsSync(path)) return null;
  try {
    const parsed = RunLedgerSnapshotSchema.safeParse(JSON.parse(readFileSync(path, "utf-8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// Heuristic: maps base-blueprint agent names to the session types defined in
// the Phase 1 plan. Unknown agents default to "child_agent" (safe fallback for
// spend attribution — they'll still show up in the ledger).
function inferSessionType(agentName: string): SessionType {
  const n = agentName.toLowerCase();
  if (n.includes("grader") || n.includes("rubric")) return "rubric";
  if (n.includes("memory") || n.includes("reflection")) return "memory";
  if (n.includes("coordinator") || n.includes("orchestrator")) return "coordinator";
  if (n.includes("lead")) return "team_lead";
  if (n.includes("subagent")) return "subagent";
  return "child_agent";
}
