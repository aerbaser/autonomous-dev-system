import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInitialState } from "../../src/state/project-state.js";
import type { Config } from "../../src/utils/config.js";

const TEST_DIR = join(tmpdir(), `ads-test-factory-${process.pid}`);

// Mock SDK and domain analyzer
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("../../src/agents/domain-analyzer.js", () => ({
  analyzeDomain: vi.fn(),
  generateDomainAgents: vi.fn(),
}));

const { analyzeDomain, generateDomainAgents } = await import("../../src/agents/domain-analyzer.js");
const { buildAgentTeam } = await import("../../src/agents/factory.js");

const mockedAnalyzeDomain = vi.mocked(analyzeDomain);
const mockedGenerateDomainAgents = vi.mocked(generateDomainAgents);

function makeConfig(): Config {
  return {
    model: "claude-sonnet-4-6",
    subagentModel: "claude-sonnet-4-6",
    selfImprove: { enabled: false, maxIterations: 50, nightlyOptimize: false },
    projectDir: TEST_DIR,
    stateDir: join(TEST_DIR, ".autonomous-dev"),
  };
}

describe("Agent Factory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("builds agent team with base agents when no domain roles needed", async () => {
    mockedAnalyzeDomain.mockResolvedValue({
      classification: "web-application",
      specializations: [],
      requiredRoles: [],
      requiredMcpServers: ["playwright"],
      techStack: ["typescript", "react"],
    });

    const state = createInitialState("Build a simple todo app");
    const config = makeConfig();
    const { registry } = await buildAgentTeam(state, config);

    // Should have all 7 base agents
    const agents = registry.getAll();
    expect(agents.length).toBeGreaterThanOrEqual(7);
    expect(registry.get("developer")).toBeDefined();
    expect(registry.get("architect")).toBeDefined();
    expect(registry.get("qa-engineer")).toBeDefined();
  });

  it("builds agent team with domain-specific agents", async () => {
    mockedAnalyzeDomain.mockResolvedValue({
      classification: "fintech",
      specializations: ["trading", "risk-management"],
      requiredRoles: ["quant-researcher", "risk-analyst"],
      requiredMcpServers: ["playwright"],
      techStack: ["typescript", "python"],
    });

    mockedGenerateDomainAgents.mockResolvedValue([
      {
        name: "quant-researcher",
        role: "Quantitative Researcher",
        systemPrompt: "You are a quant researcher specializing in trading algorithms",
        tools: ["Read", "Bash", "Write"],
        evaluationCriteria: ["Strategy backtest accuracy"],
        version: 1,
      },
      {
        name: "risk-analyst",
        role: "Risk Analyst",
        systemPrompt: "You are a risk analyst evaluating portfolio risk",
        tools: ["Read", "Bash"],
        evaluationCriteria: ["Risk assessment accuracy"],
        version: 1,
      },
    ]);

    const state = createInitialState("Build a trading platform");
    const config = makeConfig();
    const { registry } = await buildAgentTeam(state, config);

    // Should have base agents + domain agents
    const agents = registry.getAll();
    expect(agents.length).toBeGreaterThanOrEqual(9); // 7 base + 2 domain

    // Verify domain agents are registered
    expect(registry.get("quant-researcher")).toBeDefined();
    expect(registry.get("quant-researcher")!.role).toBe("Quantitative Researcher");
    expect(registry.get("risk-analyst")).toBeDefined();
  });

  it("reuses existing domain agents on subsequent calls", async () => {
    // First call creates domain agents
    mockedAnalyzeDomain.mockResolvedValue({
      classification: "fintech",
      specializations: ["trading"],
      requiredRoles: ["quant-researcher"],
      requiredMcpServers: [],
      techStack: ["typescript"],
    });

    mockedGenerateDomainAgents.mockResolvedValue([
      {
        name: "quant-researcher",
        role: "Quantitative Researcher",
        systemPrompt: "You are a quant",
        tools: ["Read", "Bash"],
        evaluationCriteria: ["Backtest results"],
        version: 1,
      },
    ]);

    const state = createInitialState("Build a trading bot");
    const config = makeConfig();

    // First call — generates and saves
    const result1 = await buildAgentTeam(state, config);
    result1.registry.save();

    // Reset mocks
    vi.clearAllMocks();

    // Second call — should reuse without calling analyzeDomain
    const result2 = await buildAgentTeam(state, config);
    expect(result2.registry.get("quant-researcher")).toBeDefined();
    expect(mockedAnalyzeDomain).not.toHaveBeenCalled();
  });
});
