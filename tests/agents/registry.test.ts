import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../../src/agents/registry.js";
import type { Config } from "../../src/utils/config.js";

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

  it("can convert a subagent into a Codex-backed proxy definition", () => {
    const registry = new AgentRegistry(TEST_STATE_DIR);
    const config = {
      projectDir: TEST_STATE_DIR,
      stateDir: join(TEST_STATE_DIR, ".autonomous-dev"),
      codexSubagents: {
        enabled: true,
        model: "gpt-5.4",
        reasoningEffort: "xhigh",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        ephemeral: true,
        skipGitRepoCheck: true,
      },
    } as Config;

    const def = registry.toAgentDefinition("developer", config);

    expect(def.description).toContain("Codex-backed");
    expect(def.prompt).toContain("## FORWARDED ASSIGNMENT FOR CODEX");
    expect(def.prompt).toContain("gpt-5.4");
    expect(def.prompt).toContain("reasoning effort \"xhigh\"");
    expect(def.tools).toContain("Bash");
    expect(def.tools).not.toContain("Agent");
  });

  // ── Domain agent matching ─────────────────────────────────────────────────

  it("finds domain agent by exact name (task.domain field lookup)", () => {
    const registry = new AgentRegistry(TEST_STATE_DIR);
    registry.register({
      name: "payments-specialist",
      role: "Payments Specialist",
      systemPrompt: "You are a payments expert",
      tools: ["Read", "Bash"],
      evaluationCriteria: [],
      version: 1,
    });

    // Simulates: const agent = registry.get(task.domain)
    const agent = registry.get("payments-specialist");
    expect(agent).toBeDefined();
    expect(agent!.name).toBe("payments-specialist");
    expect(agent!.role).toBe("Payments Specialist");
  });

  it("keyword fallback: getAll().find() matches agent by name in task title", () => {
    const registry = new AgentRegistry(TEST_STATE_DIR);
    registry.register({
      name: "ml-engineer",
      role: "Machine Learning Engineer",
      systemPrompt: "You are an ML engineer",
      tools: ["Bash", "Read"],
      evaluationCriteria: [],
      version: 1,
    });

    const BASE_NAMES = new Set(["developer", "qa-engineer", "architect", "product-manager", "reviewer", "devops", "analytics"]);
    const domainAgents = registry.getAll().filter((bp) => !BASE_NAMES.has(bp.name));

    // Title contains the agent name — should match
    const titleWithName = "implement ml-engineer model training pipeline";
    const matchByName = domainAgents.find((bp) =>
      titleWithName.toLowerCase().includes(bp.name.toLowerCase())
    );
    expect(matchByName).toBeDefined();
    expect(matchByName!.name).toBe("ml-engineer");
  });

  it("keyword fallback: getAll().find() matches agent by role keyword in task title", () => {
    const registry = new AgentRegistry(TEST_STATE_DIR);
    registry.register({
      name: "security-auditor",
      role: "Security Auditor",
      systemPrompt: "You are a security auditor",
      tools: ["Read", "Grep"],
      evaluationCriteria: [],
      version: 1,
    });

    const BASE_NAMES = new Set(["developer", "qa-engineer", "architect", "product-manager", "reviewer", "devops", "analytics"]);
    const domainAgents = registry.getAll().filter((bp) => !BASE_NAMES.has(bp.name));

    // Title contains part of the role — should match
    const titleWithRole = "security auditor review of authentication module";
    const matchByRole = domainAgents.find((bp) =>
      titleWithRole.toLowerCase().includes(bp.role.toLowerCase())
    );
    expect(matchByRole).toBeDefined();
    expect(matchByRole!.name).toBe("security-auditor");
  });

  it("returns undefined when no domain name or role keyword matches task title", () => {
    const registry = new AgentRegistry(TEST_STATE_DIR);
    // Only base agents registered

    const BASE_NAMES = new Set(["developer", "qa-engineer", "architect", "product-manager", "reviewer", "devops", "analytics"]);
    const domainAgents = registry.getAll().filter((bp) => !BASE_NAMES.has(bp.name));

    const titleNoMatch = "implement user login flow";
    const match = domainAgents.find(
      (bp) =>
        titleNoMatch.includes(bp.name.toLowerCase()) ||
        titleNoMatch.includes(bp.role.toLowerCase())
    );
    expect(match).toBeUndefined();
  });
});
