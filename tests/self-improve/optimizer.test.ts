import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentBlueprint,
  ProjectState,
} from "../../src/state/project-state.js";
import type { BenchmarkResult } from "../../src/self-improve/benchmarks.js";
import type { Mutation } from "../../src/self-improve/mutation-engine.js";

const TEST_STATE_DIR = join(tmpdir(), `ads-test-optimizer-${process.pid}`);

// ── Mocks ──

const mockQuery = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

// Track runAllBenchmarks calls to control score progression
let benchmarkCallCount = 0;
let benchmarkScoreSequence: number[] = [];

const mockRunAllBenchmarks = vi.fn(async () => {
  const score =
    benchmarkScoreSequence[benchmarkCallCount] ??
    benchmarkScoreSequence[benchmarkScoreSequence.length - 1] ??
    0.5;
  benchmarkCallCount++;
  return {
    totalScore: score,
    results: [
      {
        benchmarkId: "code-quality",
        score,
        details: {},
        timestamp: new Date().toISOString(),
      },
    ] satisfies BenchmarkResult[],
    totalCostUsd: 0.001,
  };
});

vi.mock("../../src/self-improve/benchmarks.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    runAllBenchmarks: (...args: unknown[]) => mockRunAllBenchmarks(...args),
  };
});

// Track mutations generated
const mockGenerateMutations = vi.fn(async () => [] as Mutation[]);

vi.mock("../../src/self-improve/mutation-engine.js", () => ({
  generateMutations: (...args: unknown[]) => mockGenerateMutations(...args),
}));

// Mock versioning (filesystem writes)
vi.mock("../../src/self-improve/versioning.js", () => ({
  savePromptVersion: vi.fn(),
}));

// Mock state persistence
vi.mock("../../src/state/project-state.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    saveState: vi.fn(),
  };
});

// Mock AgentRegistry
const mockAgents: AgentBlueprint[] = [
  {
    name: "developer",
    role: "Software Developer",
    systemPrompt: "You write code.",
    tools: ["Read", "Write", "Bash"],
    evaluationCriteria: ["code quality"],
    version: 1,
    score: 0.6,
  },
  {
    name: "reviewer",
    role: "Code Reviewer",
    systemPrompt: "You review code.",
    tools: ["Read", "Grep"],
    evaluationCriteria: ["review quality"],
    version: 1,
    score: 0.8,
  },
];

let mockPerformanceHistory: Record<string, { score: number }[]> = {};

vi.mock("../../src/agents/registry.js", () => {
  class MockAgentRegistry {
    getAll() {
      return mockAgents;
    }
    get(name: string) {
      return mockAgents.find((a) => a.name === name);
    }
    getAverageScore(name: string) {
      const history = mockPerformanceHistory[name];
      if (!history || history.length === 0) return 0;
      return history.reduce((sum, p) => sum + p.score, 0) / history.length;
    }
    recordPerformance(name: string, perf: { score: number }) {
      if (!mockPerformanceHistory[name]) mockPerformanceHistory[name] = [];
      mockPerformanceHistory[name]!.push(perf);
    }
    register() {}
    save() {}
  }
  return { AgentRegistry: MockAgentRegistry };
});

// Dynamic import after mocks
const { runOptimizer } = await import("../../src/self-improve/optimizer.js");

function makeState(overrides?: Partial<ProjectState>): ProjectState {
  return {
    id: "test-id",
    idea: "test project",
    currentPhase: "development",
    spec: null,
    architecture: null,
    environment: null,
    agents: [],
    tasks: [],
    deployments: [],
    abTests: [],
    evolution: [],
    checkpoints: [],
    sessionIds: {},
    baselineScore: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeConfig() {
  return {
    stateDir: TEST_STATE_DIR,
    projectDir: "/tmp/test-project",
    maxCostUsd: 10,
    dryRun: false,
    model: "sonnet" as const,
  };
}

function makeMutation(overrides?: Partial<Mutation>): Mutation {
  const originalPrompt = "original prompt";
  const newPrompt = "improved prompt";
  return {
    id: "mut-1",
    targetName: "developer",
    type: "agent_prompt",
    description: "Optimized developer prompt",
    apply: () => ({
      ...mockAgents[0]!,
      systemPrompt: newPrompt,
      version: 2,
    }),
    rollback: () => ({
      ...mockAgents[0]!,
      systemPrompt: originalPrompt,
    }),
    ...overrides,
  };
}

describe("Optimizer", () => {
  beforeEach(() => {
    benchmarkCallCount = 0;
    benchmarkScoreSequence = [];
    mockPerformanceHistory = {};
    mockQuery.mockReset();
    mockGenerateMutations.mockReset();
    mockGenerateMutations.mockResolvedValue([]);

    if (existsSync(TEST_STATE_DIR))
      rmSync(TEST_STATE_DIR, { recursive: true });
    mkdirSync(TEST_STATE_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_STATE_DIR))
      rmSync(TEST_STATE_DIR, { recursive: true });
  });

  it("selectTargetAgent picks worst-performing agent", async () => {
    // Set up performance history so developer is worse than reviewer
    mockPerformanceHistory = {
      developer: [{ score: 0.4 }, { score: 0.5 }],
      reviewer: [{ score: 0.8 }, { score: 0.9 }],
    };

    // Baseline = 0.5, then mutation improves to 0.6
    benchmarkScoreSequence = [0.5, 0.6];
    mockGenerateMutations.mockResolvedValue([makeMutation()]);

    const state = makeState();
    await runOptimizer(state, makeConfig(), { maxIterations: 1 });

    // The mutation targets "developer" (worst performer);
    // verify through the evolution entry pushed to state.evolution (shared ref)
    expect(state.evolution.length).toBeGreaterThanOrEqual(1);
    expect(state.evolution[0]!.target).toBe("developer");
  });

  it("accepts mutations that improve the score", async () => {
    // Baseline = 0.5, after mutation = 0.7
    benchmarkScoreSequence = [0.5, 0.7];
    mockGenerateMutations.mockResolvedValue([makeMutation()]);

    const state = makeState();
    await runOptimizer(state, makeConfig(), { maxIterations: 1 });

    const accepted = state.evolution.filter((e) => e.accepted);
    expect(accepted.length).toBe(1);
    expect(accepted[0]!.scoreAfter).toBe(0.7);
    expect(accepted[0]!.scoreBefore).toBe(0.5);
  });

  it("rejects mutations that do not improve the score", async () => {
    // Baseline = 0.5, after mutation = 0.4 (worse)
    benchmarkScoreSequence = [0.5, 0.4];
    mockGenerateMutations.mockResolvedValue([makeMutation()]);

    const state = makeState();
    await runOptimizer(state, makeConfig(), { maxIterations: 1 });

    const rejected = state.evolution.filter((e) => !e.accepted);
    expect(rejected.length).toBe(1);
    expect(rejected[0]!.scoreAfter).toBe(0.4);
    expect(rejected[0]!.scoreBefore).toBe(0.5);
  });

  it("stops early when convergence is detected", async () => {
    // All scores the same — should converge after minIterations
    benchmarkScoreSequence = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
    // No mutations generated — triggers the "no mutations, skip" path
    mockGenerateMutations.mockResolvedValue([]);

    const state = makeState();
    await runOptimizer(state, makeConfig(), {
      maxIterations: 100,
      convergence: {
        minIterations: 3,
        maxStagnantIterations: 3,
        windowSize: 3,
        minImprovement: 0.005,
      },
    });

    // Should have stopped well before 100 iterations (no evolution entries)
    expect(state.evolution.length).toBe(0);
  });

  it("runs multiple iterations accepting and rejecting", async () => {
    // Baseline = 0.5, iteration 1 → 0.6 (accept), iteration 2 → 0.55 (reject)
    benchmarkScoreSequence = [0.5, 0.6, 0.55];

    let callNum = 0;
    mockGenerateMutations.mockImplementation(async () => {
      callNum++;
      return [makeMutation({ id: `mut-${callNum}` })];
    });

    const state = makeState();
    await runOptimizer(state, makeConfig(), {
      maxIterations: 2,
      convergence: { maxStagnantIterations: 100, minIterations: 100 },
    });

    expect(state.evolution.length).toBe(2);
    expect(state.evolution[0]!.accepted).toBe(true);
    expect(state.evolution[1]!.accepted).toBe(false);
  });

  it("handles zero mutations gracefully", async () => {
    benchmarkScoreSequence = [0.5];
    mockGenerateMutations.mockResolvedValue([]);

    const state = makeState();
    await runOptimizer(state, makeConfig(), {
      maxIterations: 3,
      convergence: { maxStagnantIterations: 100, minIterations: 100 },
    });

    // No evolution entries should be created when no mutations are generated
    expect(state.evolution).toEqual([]);
  });

  it("uses round-robin fallback when no performance data exists", async () => {
    // No performance history — selectTargetAgent uses round-robin
    mockPerformanceHistory = {};

    benchmarkScoreSequence = [0.5, 0.6];
    mockGenerateMutations.mockResolvedValue([makeMutation()]);

    const state = makeState();
    await runOptimizer(state, makeConfig(), { maxIterations: 1 });

    // With no perf data, round-robin picks agents[iteration % length]
    // iteration=0, agents.length=2 → agents[0] = "developer"
    expect(state.evolution.length).toBe(1);
    expect(state.evolution[0]!.target).toBe("developer");
  });
});
