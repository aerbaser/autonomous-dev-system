import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../../src/agents/registry.js";

const TEST_STATE_DIR = join(tmpdir(), `ads-test-registry-${process.pid}`);

describe("AgentRegistry", () => {
  beforeEach(() => {
    if (existsSync(TEST_STATE_DIR)) rmSync(TEST_STATE_DIR, { recursive: true });
    mkdirSync(TEST_STATE_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_STATE_DIR)) rmSync(TEST_STATE_DIR, { recursive: true });
  });

  it("initializes with base blueprints", () => {
    const registry = new AgentRegistry(TEST_STATE_DIR);
    const all = registry.getAll();

    expect(all.length).toBeGreaterThanOrEqual(7);
    expect(registry.get("product-manager")).toBeDefined();
    expect(registry.get("developer")).toBeDefined();
    expect(registry.get("qa-engineer")).toBeDefined();
    expect(registry.get("reviewer")).toBeDefined();
    expect(registry.get("devops")).toBeDefined();
    expect(registry.get("analytics")).toBeDefined();
    expect(registry.get("architect")).toBeDefined();
  });

  it("registers custom agents", () => {
    const registry = new AgentRegistry(TEST_STATE_DIR);
    registry.register({
      name: "quant-researcher",
      role: "Quantitative Researcher",
      systemPrompt: "You are a quant...",
      tools: ["Read", "Bash", "WebSearch"],
      evaluationCriteria: ["Strategy backtest results"],
      version: 1,
    });

    const agent = registry.get("quant-researcher");
    expect(agent).toBeDefined();
    expect(agent!.role).toBe("Quantitative Researcher");
  });

  it("persists and loads", () => {
    const registry = new AgentRegistry(TEST_STATE_DIR);
    registry.register({
      name: "test-agent",
      role: "Test",
      systemPrompt: "test prompt",
      tools: ["Read"],
      evaluationCriteria: [],
      version: 1,
    });
    registry.save();

    const loaded = new AgentRegistry(TEST_STATE_DIR);
    expect(loaded.get("test-agent")).toBeDefined();
    expect(loaded.get("test-agent")!.systemPrompt).toBe("test prompt");
  });

  it("evolves agents with version increment", () => {
    const registry = new AgentRegistry(TEST_STATE_DIR);
    const original = registry.get("developer")!;
    expect(original.version).toBe(1);

    const evolved = registry.evolve("developer", {
      systemPrompt: "Improved prompt",
    });

    expect(evolved.version).toBe(2);
    expect(evolved.systemPrompt).toBe("Improved prompt");
    expect(registry.get("developer")!.version).toBe(2);
  });

  it("records and retrieves performance history", () => {
    const registry = new AgentRegistry(TEST_STATE_DIR);
    registry.recordPerformance("developer", {
      benchmarkId: "code-quality",
      score: 0.85,
      timestamp: new Date().toISOString(),
    });
    registry.recordPerformance("developer", {
      benchmarkId: "code-quality",
      score: 0.9,
      timestamp: new Date().toISOString(),
    });

    const history = registry.getPerformanceHistory("developer");
    expect(history).toHaveLength(2);

    const avg = registry.getAverageScore("developer");
    expect(avg).toBeCloseTo(0.875);
  });

  it("converts to AgentDefinition format", () => {
    const registry = new AgentRegistry(TEST_STATE_DIR);
    const def = registry.toAgentDefinition("developer");

    expect(def.description).toContain("Software Developer");
    expect(def.prompt).toBeTruthy();
    expect(def.tools).toContain("Read");
    expect(def.tools).toContain("Write");
  });
});
