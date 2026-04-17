import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/state/memory-store.js";
import { SkillStore, extractSignature } from "../../src/memory/skills.js";
import type { TaskReceipt } from "../../src/types/task-receipt.js";

const TEST_STATE_DIR = join(tmpdir(), `ads-test-skills-${process.pid}`);

function receipt(overrides: Partial<TaskReceipt> = {}): TaskReceipt {
  const now = new Date().toISOString();
  return {
    taskId: "task-001",
    taskTitle: "Add user authentication endpoint",
    teamMemberId: "dev-1",
    agentRole: "Software Developer",
    model: "claude-sonnet-4-6",
    sessionIds: ["session-1"],
    changedFiles: ["src/auth/login.ts"],
    verificationCommands: [
      { command: "npx tsc --noEmit", success: true, exitCode: 0 },
    ],
    status: "success",
    startedAt: now,
    completedAt: now,
    ...overrides,
  };
}

describe("extractSignature", () => {
  it("strips stopwords, lowercases, applies length >= 3 filter", () => {
    const sig = extractSignature("Add a login TO the API", "api", "development");

    expect(sig.domain).toBe("api");
    expect(sig.phase).toBe("development");
    // "a" and "to" and "the" are stopwords; remaining: "add", "login", "api"
    expect(sig.titleKeywords).toEqual(["add", "login", "api"]);
  });

  it("filters tokens shorter than 3 characters", () => {
    const sig = extractSignature("JS vs TS implementation", "generic", "development");
    // "JS", "vs", "TS" are all < 3 chars → dropped; "implementation" kept
    expect(sig.titleKeywords).toEqual(["implementation"]);
  });

  it("returns empty keywords when everything filters out", () => {
    const sig = extractSignature("a to the", "generic", "development");
    expect(sig.titleKeywords).toEqual([]);
  });
});

describe("SkillStore", () => {
  let memory: MemoryStore;
  let skills: SkillStore;

  beforeEach(() => {
    if (existsSync(TEST_STATE_DIR)) rmSync(TEST_STATE_DIR, { recursive: true });
    mkdirSync(TEST_STATE_DIR, { recursive: true });
    memory = new MemoryStore(TEST_STATE_DIR);
    skills = new SkillStore(memory);
  });

  afterEach(() => {
    if (existsSync(TEST_STATE_DIR)) rmSync(TEST_STATE_DIR, { recursive: true });
  });

  it("crystallize writes a doc with topic prefix 'skill:' and correct tags", async () => {
    const playbook = await skills.crystallize(receipt(), {
      domain: "api",
      phase: "development",
    });

    expect(playbook.taskTitle).toBe("Add user authentication endpoint");
    expect(playbook.changedFiles).toEqual(["src/auth/login.ts"]);
    expect(playbook.verificationCommands).toEqual(["npx tsc --noEmit"]);
    expect(playbook.successCount).toBe(1);
    expect(playbook.useCount).toBe(0);

    const docs = await memory.list({ tags: ["skill"] });
    expect(docs.length).toBe(1);
    expect(docs[0]!.topic.startsWith("skill:")).toBe(true);
    expect(docs[0]!.tags).toContain("skill");
    expect(docs[0]!.tags).toContain("api");
    expect(docs[0]!.tags).toContain("development");
    // Title keywords should be present in tags
    expect(docs[0]!.tags).toContain("authentication");
  });

  it("findMatching returns playbook by domain+phase and ignores irrelevant tags", async () => {
    await skills.crystallize(receipt(), { domain: "api", phase: "development" });
    await skills.crystallize(
      receipt({
        taskId: "task-002",
        taskTitle: "Deploy container to Kubernetes cluster",
        changedFiles: ["deploy/k8s.yaml"],
      }),
      { domain: "devops", phase: "staging" },
    );

    const apiMatches = await skills.findMatching(
      extractSignature("Add auth endpoint", "api", "development"),
    );
    expect(apiMatches.length).toBeGreaterThan(0);
    expect(apiMatches[0]!.taskTitle).toContain("authentication");

    const noMatch = await skills.findMatching(
      extractSignature("Build billing dashboard", "billing", "development"),
    );
    expect(noMatch).toEqual([]);
  });

  it("ranks by keyword overlap — higher overlap ranks first", async () => {
    await skills.crystallize(
      receipt({
        taskId: "t1",
        taskTitle: "Add login endpoint",
        changedFiles: ["src/login.ts"],
      }),
      { domain: "api", phase: "development" },
    );
    await skills.crystallize(
      receipt({
        taskId: "t2",
        taskTitle: "Add user authentication endpoint",
        changedFiles: ["src/auth.ts"],
      }),
      { domain: "api", phase: "development" },
    );

    const sig = extractSignature(
      "user authentication login flow",
      "api",
      "development",
    );
    const matches = await skills.findMatching(sig, 2);
    // "Add user authentication endpoint" shares {user, authentication}; "Add login endpoint" shares {login}
    expect(matches[0]!.taskTitle).toBe("Add user authentication endpoint");
  });

  it("crystallizing twice with same signature increments successCount", async () => {
    const first = await skills.crystallize(receipt(), {
      domain: "api",
      phase: "development",
    });
    expect(first.successCount).toBe(1);

    const second = await skills.crystallize(receipt(), {
      domain: "api",
      phase: "development",
    });
    expect(second.id).toBe(first.id);
    expect(second.successCount).toBe(2);
    expect(second.useCount).toBe(1);

    // Still exactly one doc in memory
    const docs = await memory.list({ tags: ["skill"] });
    expect(docs.length).toBe(1);
  });

  it("recordUse bumps useCount without bumping successCount", async () => {
    const created = await skills.crystallize(receipt(), {
      domain: "api",
      phase: "development",
    });

    await skills.recordUse(created.id);

    const docs = await memory.list({ tags: ["skill"] });
    const raw = JSON.parse(docs[0]!.content) as { successCount: number; useCount: number };
    expect(raw.successCount).toBe(1);
    expect(raw.useCount).toBe(1);
  });

  it("tracks avgCostUsd across crystallizations", async () => {
    await skills.crystallize(receipt(), {
      domain: "api",
      phase: "development",
      costUsd: 0.1,
    });
    const second = await skills.crystallize(receipt(), {
      domain: "api",
      phase: "development",
      costUsd: 0.3,
    });
    // prev=0.1 (count=1), new=0.3 → (0.1 * 1 + 0.3) / 2 = 0.2
    expect(second.avgCostUsd).toBeCloseTo(0.2, 5);
  });
});
