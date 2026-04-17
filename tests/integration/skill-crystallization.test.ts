import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/state/memory-store.js";
import { SkillStore, extractSignature } from "../../src/memory/skills.js";
import {
  buildTaskPrompt,
  renderSkillBlock,
  resolveSkillForTask,
} from "../../src/phases/development-runner.js";
import type { TaskReceipt } from "../../src/types/task-receipt.js";
import type { Task } from "../../src/state/project-state.js";

const TEST_STATE_DIR = join(tmpdir(), `ads-test-skill-integration-${process.pid}`);

function mkReceipt(overrides: Partial<TaskReceipt> = {}): TaskReceipt {
  const now = new Date().toISOString();
  return {
    taskId: "task-123",
    taskTitle: "Add payment processing service",
    teamMemberId: "dev-1",
    agentRole: "Software Developer",
    model: "claude-sonnet-4-6",
    sessionIds: ["session-xyz"],
    changedFiles: ["src/payments/service.ts", "src/payments/schema.ts"],
    verificationCommands: [
      { command: "npx tsc --noEmit", success: true, exitCode: 0 },
      { command: "npm test", success: true, exitCode: 0 },
    ],
    status: "success",
    startedAt: now,
    completedAt: now,
    ...overrides,
  };
}

function mkTask(partial: Partial<Task> & { id: string; title: string }): Task {
  return {
    id: partial.id,
    title: partial.title,
    description: partial.description ?? "",
    status: "pending",
    ...partial,
  } as Task;
}

describe("skill-crystallization integration", () => {
  let memory: MemoryStore;
  let skills: SkillStore;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    if (existsSync(TEST_STATE_DIR)) rmSync(TEST_STATE_DIR, { recursive: true });
    mkdirSync(TEST_STATE_DIR, { recursive: true });
    memory = new MemoryStore(TEST_STATE_DIR);
    skills = new SkillStore(memory);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    if (existsSync(TEST_STATE_DIR)) rmSync(TEST_STATE_DIR, { recursive: true });
  });

  it("crystallized skill is retrievable via MemoryStore.search", async () => {
    await skills.crystallize(mkReceipt(), { domain: "generic", phase: "development" });

    const results = await memory.search("skill:", { tags: ["skill"] });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.topic.startsWith("skill:")).toBe(true);

    const parsed = JSON.parse(results[0]!.content) as {
      taskTitle: string;
      changedFiles: string[];
    };
    expect(parsed.taskTitle).toBe("Add payment processing service");
    expect(parsed.changedFiles).toContain("src/payments/service.ts");
  });

  it("pre-populated skill is injected into the task prompt via resolveSkillForTask", async () => {
    // Seed a matching playbook.
    await skills.crystallize(mkReceipt(), { domain: "generic", phase: "development" });

    // Now a similar task arrives — resolveSkillForTask should find the match
    // and log the [skill-store] Injected skill line.
    const task = mkTask({
      id: "task-999",
      title: "Add payment processing gateway",
      description: "Hook the gateway into the checkout flow",
    });

    const resolved = await resolveSkillForTask(task, "development", skills);

    expect(resolved).toBeDefined();
    expect(resolved!.taskTitle).toBe("Add payment processing service");

    // Verify the observability log was emitted exactly as spec'd.
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/\[skill-store\] Injected skill .* \(useCount=\d+\)/);
  });

  it("buildTaskPrompt includes <prior-successful-approach> block when a skill is passed", async () => {
    const playbook = await skills.crystallize(mkReceipt(), {
      domain: "generic",
      phase: "development",
    });

    const task = mkTask({
      id: "t-abc",
      title: "Add payment processing gateway",
      description: "Implement gateway",
    });

    const prompt = buildTaskPrompt(task, "shared-context-block", undefined, playbook);
    expect(prompt).toContain("<prior-successful-approach>");
    expect(prompt).toContain("Previously-successful approach for similar task");
    expect(prompt).toContain("src/payments/service.ts");
    expect(prompt).toContain("npx tsc --noEmit");
    expect(prompt).toContain("</prior-successful-approach>");
  });

  it("renderSkillBlock handles empty changed files / commands with placeholders", async () => {
    const playbook = await skills.crystallize(
      mkReceipt({
        changedFiles: [],
        verificationCommands: [],
      }),
      { domain: "generic", phase: "development" },
    );

    const block = renderSkillBlock(playbook);
    expect(block).toContain("Files typically changed: (none recorded)");
    expect(block).toContain("Verification: (none recorded)");
  });

  it("resolveSkillForTask with null skillStore returns undefined", async () => {
    const task = mkTask({ id: "t-1", title: "anything", description: "" });
    const resolved = await resolveSkillForTask(task, "development", null);
    expect(resolved).toBeUndefined();
  });

  it("resolveSkillForTask bumps useCount when a match is injected", async () => {
    await skills.crystallize(mkReceipt(), { domain: "generic", phase: "development" });

    const task = mkTask({
      id: "t-inject",
      title: "Add payment processing module",
      description: "",
    });

    await resolveSkillForTask(task, "development", skills);

    // Reload playbook and assert useCount incremented.
    const matches = await skills.findMatching(
      extractSignature(task.title, "generic", "development"),
    );
    expect(matches[0]!.useCount).toBe(1);
  });

  describe("domain fallback chain (task → state → 'generic')", () => {
    it("falls back to project classification when the task has no own domain", async () => {
      // Seed a skill under the project-level domain.
      await skills.crystallize(mkReceipt(), {
        domain: "telegram-bot",
        phase: "development",
      });

      const task = mkTask({
        id: "t-no-domain",
        title: "Add payment processing module",
        description: "",
      });

      const resolved = await resolveSkillForTask(
        task,
        "development",
        skills,
        "telegram-bot",
      );
      expect(resolved).toBeDefined();
      expect(resolved!.signature.domain).toBe("telegram-bot");
    });

    it("task's own domain wins over the project-level domain", async () => {
      // A "telegram-bot" skill exists at the project level, but the task
      // belongs to the "email-bot" domain — no cross-domain reuse.
      await skills.crystallize(mkReceipt(), {
        domain: "telegram-bot",
        phase: "development",
      });

      const task = mkTask({
        id: "t-own-domain",
        title: "Add payment processing module",
        description: "",
        domain: "email-bot",
      });

      const resolved = await resolveSkillForTask(
        task,
        "development",
        skills,
        "telegram-bot",
      );
      expect(resolved).toBeUndefined();
    });

    it("normalizes human-friendly project classifications via toDomainSlug", async () => {
      // Skill stored under slug form.
      await skills.crystallize(mkReceipt(), {
        domain: "web-application",
        phase: "development",
      });

      const task = mkTask({
        id: "t-slug",
        title: "Add payment processing module",
        description: "",
      });

      const resolved = await resolveSkillForTask(
        task,
        "development",
        skills,
        "Web Application",
      );
      expect(resolved).toBeDefined();
      expect(resolved!.signature.domain).toBe("web-application");
    });

    it("falls back to 'generic' when neither task nor state carry a domain", async () => {
      await skills.crystallize(mkReceipt(), {
        domain: "generic",
        phase: "development",
      });

      const task = mkTask({
        id: "t-generic",
        title: "Add payment processing module",
        description: "",
      });

      const resolved = await resolveSkillForTask(
        task,
        "development",
        skills,
        undefined,
      );
      expect(resolved).toBeDefined();
      expect(resolved!.signature.domain).toBe("generic");
    });
  });
});
