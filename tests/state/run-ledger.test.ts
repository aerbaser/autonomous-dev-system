import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  RunLedger,
  loadLedger,
  SessionTypeSchema,
  ReasonCodeSchema,
  RunLedgerSnapshotSchema,
  getActiveLedger,
  setActiveLedger,
} from "../../src/state/run-ledger.js";
import { EventBus } from "../../src/events/event-bus.js";

const TEST_STATE_DIR = join(tmpdir(), `ads-test-ledger-${process.pid}`);

describe("RunLedger", () => {
  beforeEach(() => {
    if (existsSync(TEST_STATE_DIR)) rmSync(TEST_STATE_DIR, { recursive: true });
    mkdirSync(TEST_STATE_DIR, { recursive: true });
    setActiveLedger(null);
  });

  afterEach(() => {
    if (existsSync(TEST_STATE_DIR)) rmSync(TEST_STATE_DIR, { recursive: true });
    setActiveLedger(null);
  });

  describe("session lifecycle", () => {
    it("startSession creates a record with defaults", () => {
      const ledger = new RunLedger();
      const record = ledger.startSession({
        sessionId: "s1",
        phase: "development",
        role: "team-lead",
        sessionType: "team_lead",
      });
      expect(record.sessionId).toBe("s1");
      expect(record.phase).toBe("development");
      expect(record.sessionType).toBe("team_lead");
      expect(record.spend.costUsd).toBe(0);
      expect(record.failures).toEqual([]);
      expect(record.startedAt).toBeTruthy();
      expect(record.endedAt).toBeUndefined();
    });

    it("startSession with same sessionId is idempotent", () => {
      const ledger = new RunLedger();
      const r1 = ledger.startSession({ sessionId: "s1", phase: "ideation", role: "a", sessionType: "coordinator" });
      const r2 = ledger.startSession({ sessionId: "s1", phase: "ideation", role: "a", sessionType: "coordinator" });
      expect(r2).toBe(r1);
      expect(ledger.listSessions()).toHaveLength(1);
    });

    it("endSession writes spend, success and durationMs", () => {
      const ledger = new RunLedger();
      ledger.startSession({ sessionId: "s1", phase: "development", role: "codex", sessionType: "child_agent" });
      const updated = ledger.endSession("s1", {
        success: true,
        durationMs: 1234,
        spend: { costUsd: 0.25, inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 },
      });
      expect(updated).not.toBeNull();
      expect(updated!.success).toBe(true);
      expect(updated!.durationMs).toBe(1234);
      expect(updated!.spend.costUsd).toBe(0.25);
      expect(updated!.spend.cacheReadTokens).toBe(10);
      expect(updated!.endedAt).toBeTruthy();
    });

    it("endSession returns null for unknown sessionId", () => {
      const ledger = new RunLedger();
      expect(ledger.endSession("missing", { success: true })).toBeNull();
    });
  });

  describe("reason codes", () => {
    it("recordFailure appends failure and marks session unsuccessful", () => {
      const ledger = new RunLedger();
      ledger.startSession({ sessionId: "s1", phase: "development", role: "codex", sessionType: "child_agent" });
      const updated = ledger.recordFailure("s1", "provider_limit", "quota exhausted");
      expect(updated).not.toBeNull();
      expect(updated!.failures).toHaveLength(1);
      expect(updated!.failures[0]!.reasonCode).toBe("provider_limit");
      expect(updated!.failures[0]!.message).toBe("quota exhausted");
      expect(updated!.success).toBe(false);
    });

    it("recordFailure returns null for unknown session", () => {
      const ledger = new RunLedger();
      expect(ledger.recordFailure("missing", "verification_failed", "oops")).toBeNull();
    });

    it("ReasonCodeSchema accepts all enum values and rejects unknown", () => {
      expect(ReasonCodeSchema.safeParse("provider_limit").success).toBe(true);
      expect(ReasonCodeSchema.safeParse("provider_rate_limit").success).toBe(true);
      expect(ReasonCodeSchema.safeParse("invalid_structured_output").success).toBe(true);
      expect(ReasonCodeSchema.safeParse("verification_failed").success).toBe(true);
      expect(ReasonCodeSchema.safeParse("blocked_filesystem").success).toBe(true);
      expect(ReasonCodeSchema.safeParse("unsupported_team_runtime").success).toBe(true);
      // Canonical superset also contains the governor-side codes.
      expect(ReasonCodeSchema.safeParse("transient").success).toBe(true);
      expect(ReasonCodeSchema.safeParse("timeout").success).toBe(true);
      expect(ReasonCodeSchema.safeParse("unknown").success).toBe(true);
      expect(ReasonCodeSchema.safeParse("nope").success).toBe(false);
    });

    it("SessionTypeSchema accepts all 7 session types", () => {
      const types = ["coordinator", "team_lead", "child_agent", "subagent", "rubric", "memory", "retry"];
      for (const t of types) expect(SessionTypeSchema.safeParse(t).success).toBe(true);
      expect(SessionTypeSchema.safeParse("unknown").success).toBe(false);
    });
  });

  describe("snapshot + aggregates", () => {
    it("aggregates spend across sessions and groups by type", () => {
      const ledger = new RunLedger();
      ledger.startSession({ sessionId: "a", phase: "development", role: "lead", sessionType: "team_lead" });
      ledger.endSession("a", { success: true, spend: { costUsd: 1.0, inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 } });
      ledger.startSession({ sessionId: "b", phase: "development", role: "codex", sessionType: "child_agent" });
      ledger.endSession("b", { success: true, spend: { costUsd: 2.0, inputTokens: 5, outputTokens: 7, cacheReadTokens: 2, cacheWriteTokens: 3 } });
      ledger.startSession({ sessionId: "c", phase: "development", role: "codex2", sessionType: "child_agent" });
      ledger.recordFailure("c", "provider_rate_limit", "429");

      const snap = ledger.snapshot();
      expect(snap.aggregates.totalCostUsd).toBe(3.0);
      expect(snap.aggregates.totalInputTokens).toBe(15);
      expect(snap.aggregates.totalOutputTokens).toBe(27);
      expect(snap.aggregates.byType["team_lead"]!.sessions).toBe(1);
      expect(snap.aggregates.byType["child_agent"]!.sessions).toBe(2);
      expect(snap.aggregates.byType["child_agent"]!.costUsd).toBe(2.0);
      expect(snap.aggregates.failuresByReason["provider_rate_limit"]).toBe(1);
    });

    it("snapshot passes RunLedgerSnapshotSchema validation", () => {
      const ledger = new RunLedger();
      ledger.startSession({
        sessionId: "s1",
        phase: "development",
        role: "lead",
        sessionType: "team_lead",
        taskId: "task-42",
        model: "claude-opus-4-6",
      });
      ledger.endSession("s1", { success: true, spend: { costUsd: 0.5, inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } });
      const snap = ledger.snapshot();
      const parsed = RunLedgerSnapshotSchema.safeParse(snap);
      expect(parsed.success).toBe(true);
    });
  });

  describe("persist + load", () => {
    it("persists to <stateDir>/ledger/<runId>.json and reloads via loadLedger", () => {
      const ledger = new RunLedger("run-abc");
      ledger.startSession({ sessionId: "s1", phase: "ideation", role: "ideator", sessionType: "coordinator" });
      ledger.endSession("s1", { success: true, spend: { costUsd: 0.1, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 } });

      const path = ledger.persist(TEST_STATE_DIR);
      expect(path).toContain("ledger");
      expect(path).toContain("run-abc.json");
      expect(existsSync(path)).toBe(true);

      const raw = JSON.parse(readFileSync(path, "utf-8"));
      expect(raw.runId).toBe("run-abc");
      expect(raw.sessions).toHaveLength(1);
      expect(raw.endedAt).toBeTruthy();

      const loaded = loadLedger(TEST_STATE_DIR, "run-abc");
      expect(loaded).not.toBeNull();
      expect(loaded!.sessions).toHaveLength(1);
      expect(loaded!.sessions[0]!.sessionId).toBe("s1");
      expect(loaded!.aggregates.totalCostUsd).toBe(0.1);
    });

    it("loadLedger returns null for missing file", () => {
      expect(loadLedger(TEST_STATE_DIR, "nonexistent")).toBeNull();
    });
  });

  describe("event bus integration", () => {
    it("bridges agent.query.start/end into auto-created sessions", () => {
      const ledger = new RunLedger();
      const bus = new EventBus();
      ledger.attachEventBus(bus);

      bus.emit("agent.query.start", {
        phase: "development",
        agentName: "codex-dev",
        model: "claude-sonnet-4-6",
        promptLength: 42,
      });
      bus.emit("agent.query.end", {
        phase: "development",
        agentName: "codex-dev",
        inputTokens: 500,
        outputTokens: 200,
        cacheReadInputTokens: 100,
        cacheCreationInputTokens: 50,
        costUsd: 0.33,
        durationMs: 2500,
        success: true,
      });

      const sessions = ledger.listSessions();
      expect(sessions).toHaveLength(1);
      const s = sessions[0]!;
      expect(s.phase).toBe("development");
      expect(s.role).toBe("codex-dev");
      expect(s.spend.costUsd).toBe(0.33);
      expect(s.spend.inputTokens).toBe(500);
      expect(s.spend.cacheReadTokens).toBe(100);
      expect(s.spend.cacheWriteTokens).toBe(50);
      expect(s.success).toBe(true);
    });

    it("infers session type from agent name", () => {
      const ledger = new RunLedger();
      const bus = new EventBus();
      ledger.attachEventBus(bus);

      for (const agent of ["rubric-grader", "memory-capture", "team-lead-opus"]) {
        bus.emit("agent.query.start", { phase: "development", agentName: agent, model: "m", promptLength: 0 });
        bus.emit("agent.query.end", {
          phase: "development",
          agentName: agent,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          durationMs: 1,
          success: true,
        });
      }
      const byRole = new Map(ledger.listSessions().map((s) => [s.role, s.sessionType]));
      expect(byRole.get("rubric-grader")).toBe("rubric");
      expect(byRole.get("memory-capture")).toBe("memory");
      expect(byRole.get("team-lead-opus")).toBe("team_lead");
    });

    it("infers Codex-backed subagents as child_agent", () => {
      const ledger = new RunLedger();
      const bus = new EventBus();
      ledger.attachEventBus(bus);

      for (const agent of ["codex-dev-abc123", "codex", "my-codex-worker"]) {
        bus.emit("agent.query.start", { phase: "development", agentName: agent, model: "claude-sonnet-4-6", promptLength: 0 });
        bus.emit("agent.query.end", {
          phase: "development",
          agentName: agent,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          durationMs: 1,
          success: true,
        });
      }

      const byRole = new Map(ledger.listSessions().map((s) => [s.role, s.sessionType]));
      expect(byRole.get("codex-dev-abc123")).toBe("child_agent");
      expect(byRole.get("codex")).toBe("child_agent");
      expect(byRole.get("my-codex-worker")).toBe("child_agent");
    });

    it("attachEventBus returns an unsubscribe function", () => {
      const ledger = new RunLedger();
      const bus = new EventBus();
      const unsub = ledger.attachEventBus(bus);
      unsub();
      bus.emit("agent.query.start", { phase: "development", agentName: "x", model: "m", promptLength: 0 });
      expect(ledger.listSessions()).toHaveLength(0);
    });
  });

  describe("coordinationVsImplementation (Phase 3)", () => {
    it("splits spend into coordination / implementation / auxiliary buckets", () => {
      const ledger = new RunLedger();
      // coordination bucket
      ledger.startSession({ sessionId: "c1", phase: "development", role: "lead", sessionType: "team_lead" });
      ledger.endSession("c1", { success: true, spend: { costUsd: 0.5, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } });
      ledger.startSession({ sessionId: "c2", phase: "development", role: "orch", sessionType: "coordinator" });
      ledger.endSession("c2", { success: true, spend: { costUsd: 0.25, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } });
      // implementation bucket
      ledger.startSession({ sessionId: "i1", phase: "development", role: "dev", sessionType: "child_agent" });
      ledger.endSession("i1", { success: true, spend: { costUsd: 1.5, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } });
      ledger.startSession({ sessionId: "i2", phase: "development", role: "sub", sessionType: "subagent" });
      ledger.endSession("i2", { success: true, spend: { costUsd: 0.75, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } });
      // auxiliary bucket
      ledger.startSession({ sessionId: "a1", phase: "development", role: "grader", sessionType: "rubric" });
      ledger.endSession("a1", { success: true, spend: { costUsd: 0.1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } });
      ledger.startSession({ sessionId: "a2", phase: "development", role: "mem", sessionType: "memory" });
      ledger.endSession("a2", { success: true, spend: { costUsd: 0.05, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } });

      const split = ledger.coordinationVsImplementation();
      expect(split.coordinationUsd).toBeCloseTo(0.75, 6);
      expect(split.implementationUsd).toBeCloseTo(2.25, 6);
      expect(split.auxiliaryUsd).toBeCloseTo(0.15, 6);
      // ratio ignores auxiliary noise: 0.75 / (0.75 + 2.25) = 0.25
      expect(split.ratio).toBeCloseTo(0.25, 6);
    });

    it("returns zero ratio on empty ledger", () => {
      const ledger = new RunLedger();
      const split = ledger.coordinationVsImplementation();
      expect(split.coordinationUsd).toBe(0);
      expect(split.implementationUsd).toBe(0);
      expect(split.auxiliaryUsd).toBe(0);
      expect(split.ratio).toBe(0);
    });
  });

  describe("active ledger singleton", () => {
    it("setActiveLedger / getActiveLedger round-trip", () => {
      const ledger = new RunLedger();
      expect(getActiveLedger()).toBeNull();
      setActiveLedger(ledger);
      expect(getActiveLedger()).toBe(ledger);
      setActiveLedger(null);
      expect(getActiveLedger()).toBeNull();
    });

    it("dispose() clears active ledger when it matches", () => {
      const ledger = new RunLedger();
      setActiveLedger(ledger);
      ledger.dispose();
      expect(getActiveLedger()).toBeNull();
    });
  });
});
