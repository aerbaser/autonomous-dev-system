import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/state/memory-store.js";
import { SkillStore } from "../../src/memory/skills.js";
import { LayeredMemory } from "../../src/memory/layers.js";

const TEST_STATE_DIR = join(tmpdir(), `ads-test-layers-${process.pid}`);

describe("LayeredMemory", () => {
  let memory: MemoryStore;
  let layered: LayeredMemory;

  beforeEach(() => {
    if (existsSync(TEST_STATE_DIR)) rmSync(TEST_STATE_DIR, { recursive: true });
    mkdirSync(TEST_STATE_DIR, { recursive: true });
    memory = new MemoryStore(TEST_STATE_DIR);
    layered = new LayeredMemory(memory, TEST_STATE_DIR);
  });

  afterEach(() => {
    if (existsSync(TEST_STATE_DIR)) rmSync(TEST_STATE_DIR, { recursive: true });
  });

  describe("L0 — meta-rules", () => {
    it("getRules returns the bundled seed rules (5 rules)", async () => {
      const rules = await layered.l0.getRules();
      expect(rules.length).toBe(5);
      expect(rules[0]!.id).toBe("r1");
      expect(rules[0]!.rule).toContain("Zod");
    });

    it("writeRule throws — L0 is read-only", () => {
      expect(() => layered.writeRule({ id: "rX", rule: "new rule" })).toThrow(
        /read-only/,
      );
    });
  });

  describe("L2 — facts", () => {
    it("upsertFact and getFact round-trip", async () => {
      await layered.l2.upsertFact("project-name", "autonomous-dev");
      const got = await layered.l2.getFact("project-name");
      expect(got).toBe("autonomous-dev");
    });

    it("getFact returns null when missing", async () => {
      const got = await layered.l2.getFact("nonexistent");
      expect(got).toBeNull();
    });

    it("listFacts enumerates all facts as {key, value} pairs", async () => {
      await layered.l2.upsertFact("a", "1");
      await layered.l2.upsertFact("b", "2");
      const facts = await layered.l2.listFacts();
      expect(facts.length).toBe(2);
      const keys = facts.map((f) => f.key).sort();
      expect(keys).toEqual(["a", "b"]);
    });

    it("upsert overwrites existing value", async () => {
      await layered.l2.upsertFact("key", "v1");
      await layered.l2.upsertFact("key", "v2");
      expect(await layered.l2.getFact("key")).toBe("v2");
    });
  });

  describe("L3 — skill store delegation", () => {
    it("exposes a SkillStore instance", () => {
      expect(layered.l3).toBeInstanceOf(SkillStore);
    });

    it("uses the SkillStore passed in the constructor when provided", () => {
      const customSkillStore = new SkillStore(memory);
      const withSkill = new LayeredMemory(memory, TEST_STATE_DIR, customSkillStore);
      expect(withSkill.l3).toBe(customSkillStore);
    });
  });

  describe("L4 — session archive", () => {
    it("archiveSession writes a JSONL entry; listArchive returns it", async () => {
      await layered.l4.archiveSession({
        runId: "run-1",
        phases: ["ideation", "development"],
        totalCostUsd: 1.23,
        completedAt: "2026-04-17T00:00:00.000Z",
      });

      const archivePath = join(TEST_STATE_DIR, "memory", "session-archive.jsonl");
      const raw = readFileSync(archivePath, "utf-8");
      expect(raw.split("\n").filter((l) => l.trim()).length).toBe(1);

      const entries = await layered.l4.listArchive();
      expect(entries.length).toBe(1);
      expect(entries[0]!.runId).toBe("run-1");
      expect(entries[0]!.phases).toEqual(["ideation", "development"]);
      expect(entries[0]!.totalCostUsd).toBe(1.23);
    });

    it("listArchive preserves insertion order", async () => {
      await layered.l4.archiveSession({
        runId: "run-a",
        phases: ["ideation"],
        totalCostUsd: 0.1,
        completedAt: "2026-04-17T00:00:00.000Z",
      });
      await layered.l4.archiveSession({
        runId: "run-b",
        phases: ["development"],
        totalCostUsd: 0.2,
        completedAt: "2026-04-17T01:00:00.000Z",
      });
      await layered.l4.archiveSession({
        runId: "run-c",
        phases: ["testing"],
        totalCostUsd: 0.3,
        completedAt: "2026-04-17T02:00:00.000Z",
      });

      const entries = await layered.l4.listArchive();
      expect(entries.map((e) => e.runId)).toEqual(["run-a", "run-b", "run-c"]);
    });

    it("listArchive with limit returns only the last N entries", async () => {
      for (const i of [1, 2, 3, 4]) {
        await layered.l4.archiveSession({
          runId: `run-${i}`,
          phases: [],
          totalCostUsd: 0,
          completedAt: "2026-04-17T00:00:00.000Z",
        });
      }
      const entries = await layered.l4.listArchive(2);
      expect(entries.map((e) => e.runId)).toEqual(["run-3", "run-4"]);
    });

    it("listArchive returns [] when archive file does not exist", async () => {
      const entries = await layered.l4.listArchive();
      expect(entries).toEqual([]);
    });
  });

  describe("L1 — index query", () => {
    it("queryIndex matches topics by keyword substring", async () => {
      await memory.write("billing-notes", "content", ["billing"]);
      await memory.write("auth-notes", "content", ["auth"]);

      const topics = await layered.l1.queryIndex("billing");
      expect(topics).toContain("billing-notes");
      expect(topics).not.toContain("auth-notes");
    });

    it("queryIndex matches by tag substring", async () => {
      await memory.write("topic-x", "content", ["security-review"]);
      const topics = await layered.l1.queryIndex("security");
      expect(topics).toContain("topic-x");
    });
  });
});
