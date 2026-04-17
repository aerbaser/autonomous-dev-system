import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/state/memory-store.js";
import { LayeredMemory } from "../../src/memory/layers.js";
import { SessionArchiveEntrySchema } from "../../src/memory/layers.js";

const TEST_STATE_DIR = join(tmpdir(), `ads-test-layered-integration-${process.pid}`);

describe("LayeredMemory integration — L4 archive JSONL format", () => {
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

  it("two archiveSession calls produce a JSONL file with exactly 2 valid lines", async () => {
    await layered.l4.archiveSession({
      runId: "run-alpha",
      phases: ["ideation", "specification"],
      totalCostUsd: 0.42,
      completedAt: "2026-04-17T00:00:00.000Z",
    });
    await layered.l4.archiveSession({
      runId: "run-beta",
      phases: ["ideation", "specification", "architecture", "development"],
      totalCostUsd: 1.15,
      completedAt: "2026-04-17T01:00:00.000Z",
      notes: "second run — includes development",
    });

    const archivePath = join(TEST_STATE_DIR, "memory", "session-archive.jsonl");
    expect(existsSync(archivePath)).toBe(true);

    const raw = readFileSync(archivePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(2);

    // Each line parses to a valid SessionArchiveEntry.
    for (const line of lines) {
      const parsed = SessionArchiveEntrySchema.safeParse(JSON.parse(line));
      expect(parsed.success).toBe(true);
    }

    const entries = await layered.l4.listArchive();
    expect(entries.length).toBe(2);
    expect(entries[0]!.runId).toBe("run-alpha");
    expect(entries[1]!.runId).toBe("run-beta");
    expect(entries[1]!.notes).toBe("second run — includes development");
  });

  it("archive survives interleaved L2 fact writes — layers are independent", async () => {
    await layered.l4.archiveSession({
      runId: "run-1",
      phases: [],
      totalCostUsd: 0,
      completedAt: "2026-04-17T00:00:00.000Z",
    });
    await layered.l2.upsertFact("last-run", "run-1");
    await layered.l4.archiveSession({
      runId: "run-2",
      phases: ["development"],
      totalCostUsd: 0.5,
      completedAt: "2026-04-17T01:00:00.000Z",
    });

    const entries = await layered.l4.listArchive();
    expect(entries.map((e) => e.runId)).toEqual(["run-1", "run-2"]);

    expect(await layered.l2.getFact("last-run")).toBe("run-1");
  });

  it("L0 seed rules are available without any user-provided config", async () => {
    const rules = await layered.l0.getRules();
    expect(rules.length).toBeGreaterThanOrEqual(5);
    for (const rule of rules) {
      expect(rule.id).toBeTruthy();
      expect(rule.rule.length).toBeGreaterThan(0);
    }
  });
});
