import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  saveState,
  type AgentBlueprint,
  type ProjectState,
} from "../../src/state/project-state.js";
import type { BenchmarkResult } from "../../src/self-improve/benchmarks.js";
import type { Mutation } from "../../src/self-improve/mutation-engine.js";
import type { Config } from "../../src/utils/config.js";

const mockedSaveState = vi.mocked(saveState);

// ── Mocks ──

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

let benchmarkCallCount = 0;
let benchmarkScores: number[] = [];

const mockRunAllBenchmarks = vi.fn(async () => {
  const score = benchmarkScores[benchmarkCallCount] ?? benchmarkScores[benchmarkScores.length - 1] ?? 0.5;
  benchmarkCallCount++;
  return {
    totalScore: score,
    results: [
      { benchmarkId: "code-quality", score, details: {}, timestamp: new Date().toISOString(), costUsd: 0 },
    ] satisfies BenchmarkResult[],
    totalCostUsd: 0.001,
  };
});

vi.mock("../../src/self-improve/benchmarks.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return { ...original, runAllBenchmarks: (...args: unknown[]) => mockRunAllBenchmarks(...args) };
});

const mockGenerateMutations = vi.fn(async () => [] as Mutation[]);
vi.mock("../../src/self-improve/mutation-engine.js", () => ({
  generateMutations: (...args: unknown[]) => mockGenerateMutations(...args),
}));

vi.mock("../../src/self-improve/versioning.js", () => ({
  savePromptVersion: vi.fn(),
}));

const mockRunInWorktreeSandbox = vi.fn();
vi.mock("../../src/self-improve/sandbox.js", () => ({
  runInWorktreeSandbox: (...args: unknown[]) => mockRunInWorktreeSandbox(...args),
}));

vi.mock("../../src/state/project-state.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return { ...original, saveState: vi.fn() };
});

const mockAgents: AgentBlueprint[] = [
  {
    name: "developer",
    role: "Software Developer",
    systemPrompt: "You write code.",
    tools: ["Read", "Write"],
    evaluationCriteria: ["code compiles"],
    version: 1,
    score: 0.5,
  },
];

vi.mock("../../src/agents/registry.js", () => {
  class MockAgentRegistry {
    getAll() { return mockAgents; }
    get(name: string) { return mockAgents.find((a) => a.name === name); }
    getAverageScore() { return 0; }
    recordPerformance() {}
    register() {}
    save() {}
  }
  return { AgentRegistry: MockAgentRegistry };
});

const TEST_STATE_DIR = join(process.cwd(), `.test-optimizer-runner-${process.pid}`);

const { runOptimizerImpl } = await import("../../src/self-improve/optimizer-runner.js");

// ── Helpers ──

function makeConfig(): Config {
  return {
    model: "claude-sonnet-4-6",
    subagentModel: "claude-sonnet-4-6",
    selfImprove: { enabled: true, maxIterations: 50, nightlyOptimize: false },
    projectDir: ".",
    stateDir: TEST_STATE_DIR,
    memory: { enabled: false, maxDocuments: 500, maxDocumentSizeKb: 100 },
    rubrics: { enabled: false, maxIterations: 3 },
  } as Config;
}

function makeState(): ProjectState {
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
    baselineScore: 0.5,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("runOptimizerImpl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    benchmarkCallCount = 0;
    benchmarkScores = [0.5];
    mockRunInWorktreeSandbox.mockReset();
    mockRunInWorktreeSandbox.mockImplementation(async (taskFn: any) =>
      taskFn("/tmp/worktree", new AbortController().signal)
    );
    if (existsSync(TEST_STATE_DIR)) rmSync(TEST_STATE_DIR, { recursive: true });
    mkdirSync(TEST_STATE_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_STATE_DIR)) rmSync(TEST_STATE_DIR, { recursive: true });
  });

  it("runs without mutations and completes successfully", async () => {
    mockGenerateMutations.mockResolvedValue([]);
    benchmarkScores = [0.5];

    await expect(
      runOptimizerImpl(makeState(), makeConfig(), { maxIterations: 1 })
    ).resolves.not.toThrow();
  });

  it("calls runAllBenchmarks for baseline", async () => {
    await runOptimizerImpl(makeState(), makeConfig(), { maxIterations: 0 });
    expect(mockRunAllBenchmarks).toHaveBeenCalledTimes(1); // just baseline
  });

  it("persists the refreshed baseline even when the loop exits before mutation evaluation", async () => {
    benchmarkScores = [0.72];

    await runOptimizerImpl(makeState(), makeConfig(), { maxIterations: 0 });

    expect(mockedSaveState).toHaveBeenCalledTimes(1);
    const [, persistedState] = mockedSaveState.mock.calls.at(-1)!;
    expect(persistedState.baselineScore).toBeCloseTo(0.72);
    expect(persistedState.evolution).toHaveLength(0);
  });

  it("skips iteration when no mutations are generated", async () => {
    mockGenerateMutations.mockResolvedValue([]);
    benchmarkScores = [0.5];

    await runOptimizerImpl(makeState(), makeConfig(), { maxIterations: 2 });

    // Should have baseline + 0 extra benchmark calls (no mutations to evaluate)
    expect(mockRunAllBenchmarks).toHaveBeenCalledTimes(1);
  });

  it("accepts a mutation that improves the score", async () => {
    benchmarkScores = [0.5, 0.8]; // baseline 0.5, mutation score 0.8

    const mutation: Mutation = {
      id: "mut-001",
      targetName: "developer",
      type: "agent_prompt",
      description: "Improve system prompt clarity",
      apply: () => ({ ...mockAgents[0]!, systemPrompt: "Better prompt" }),
      rollback: () => mockAgents[0]!,
    };
    mockGenerateMutations.mockResolvedValueOnce([mutation]);

    const state = makeState();
    await runOptimizerImpl(state, makeConfig(), { maxIterations: 1 });

    // Benchmark called: 1 (baseline) + 1 (mutation eval)
    expect(mockRunAllBenchmarks).toHaveBeenCalledTimes(2);
  });

  it("records a rejected evolution entry when worktree output cannot be parsed", async () => {
    benchmarkScores = [0.5];
    mockGenerateMutations.mockResolvedValueOnce([
      {
        id: "mut-parse-failure",
        targetName: "developer",
        type: "agent_prompt",
        description: "Malformed worktree output path",
        apply: () => ({ ...mockAgents[0]!, systemPrompt: "Broken" }),
        rollback: () => mockAgents[0]!,
      },
    ]);
    mockRunInWorktreeSandbox.mockResolvedValueOnce({
      success: true,
      output: "{not-json",
      exitCode: 0,
      durationMs: 12,
    });

    const state = makeState();
    await runOptimizerImpl(state, makeConfig(), {
      maxIterations: 1,
      worktreeIsolation: { repoDir: TEST_STATE_DIR },
    });

    expect(mockedSaveState).toHaveBeenCalledTimes(2);
    const [, finalState] = mockedSaveState.mock.calls.at(-1)!;
    expect(finalState.evolution).toHaveLength(1);
    expect(finalState.evolution[0]!.accepted).toBe(false);
    expect(finalState.evolution[0]!.scoreAfter).toBe(0);
    expect(mockRunInWorktreeSandbox).toHaveBeenCalledTimes(1);
  });

  it("recovers from benchmark evaluation failure without leaking the mutation", async () => {
    benchmarkScores = [0.5];
    mockGenerateMutations.mockResolvedValueOnce([
      {
        id: "mut-benchmark-failure",
        targetName: "developer",
        type: "agent_prompt",
        description: "Benchmark throws during mutation evaluation",
        apply: () => ({ ...mockAgents[0]!, systemPrompt: "Risky change" }),
        rollback: () => mockAgents[0]!,
      },
    ]);
    mockRunAllBenchmarks.mockImplementationOnce(async () => ({
      totalScore: 0.5,
      results: [
        {
          benchmarkId: "code-quality",
          score: 0.5,
          details: {},
          timestamp: new Date().toISOString(),
          costUsd: 0,
        },
      ] satisfies BenchmarkResult[],
      totalCostUsd: 0.001,
    }));
    mockRunAllBenchmarks.mockImplementationOnce(async () => {
      throw new Error("benchmark exploded");
    });

    const state = makeState();
    await expect(
      runOptimizerImpl(state, makeConfig(), { maxIterations: 1 })
    ).resolves.not.toThrow();

    expect(mockedSaveState).toHaveBeenCalledTimes(2);
    const [, finalState] = mockedSaveState.mock.calls.at(-1)!;
    expect(finalState.evolution).toHaveLength(1);
    expect(finalState.evolution[0]!.accepted).toBe(false);
    expect(finalState.evolution[0]!.scoreAfter).toBe(0);
  });

  it("stops when maxIterations is 0", async () => {
    await runOptimizerImpl(makeState(), makeConfig(), { maxIterations: 0 });

    // Only baseline benchmark runs
    expect(mockRunAllBenchmarks).toHaveBeenCalledTimes(1);
    expect(mockGenerateMutations).not.toHaveBeenCalled();
  });

  // ── Hybrid weighted acceptance (0.7 agent + 0.3 overall) ─────────────────

  function mutationFor(name: string): Mutation {
    return {
      id: `mut-${name}`,
      targetName: name,
      type: "agent_prompt",
      description: "tweak prompt",
      apply: () => ({ ...mockAgents[0]!, name, systemPrompt: "Mutated" }),
      rollback: () => mockAgents[0]!,
    };
  }

  it("hybrid acceptance: agent improves, overall flat → accept", async () => {
    // baseline overall 0.5; post-mutation overall 0.5 (flat), agent-score 0.8
    // → weighted new = 0.7*0.8 + 0.3*0.5 = 0.71
    //   weighted baseline = 0.7*0.5 + 0.3*0.5 = 0.50
    benchmarkCallCount = 0;
    benchmarkScores = [];
    mockRunAllBenchmarks.mockReset();
    mockRunAllBenchmarks
      .mockResolvedValueOnce({
        totalScore: 0.5,
        results: [
          { benchmarkId: "code-quality", score: 0.5, details: {}, timestamp: "t", costUsd: 0 },
        ] satisfies BenchmarkResult[],
        totalCostUsd: 0,
      })
      .mockResolvedValueOnce({
        totalScore: 0.5,
        results: [
          { benchmarkId: "code-quality", score: 0.8, details: {}, timestamp: "t", costUsd: 0 },
        ] satisfies BenchmarkResult[],
        totalCostUsd: 0,
      });
    mockGenerateMutations.mockResolvedValueOnce([mutationFor("developer")]);

    const state = makeState();
    await runOptimizerImpl(state, makeConfig(), { maxIterations: 1 });

    expect(mockedSaveState).toHaveBeenCalled();
    const [, finalState] = mockedSaveState.mock.calls.at(-1)!;
    expect(finalState.evolution).toHaveLength(1);
    expect(finalState.evolution[0]!.accepted).toBe(true);
  });

  it("hybrid acceptance: agent flat, overall improves → accept", async () => {
    // baseline overall 0.5; post-mutation overall 0.7, agent-score 0.5
    // → weighted new = 0.7*0.5 + 0.3*0.7 = 0.56
    //   weighted baseline = 0.7*0.5 + 0.3*0.5 = 0.50
    benchmarkCallCount = 0;
    mockRunAllBenchmarks.mockReset();
    mockRunAllBenchmarks
      .mockResolvedValueOnce({
        totalScore: 0.5,
        results: [
          { benchmarkId: "code-quality", score: 0.5, details: {}, timestamp: "t", costUsd: 0 },
        ] satisfies BenchmarkResult[],
        totalCostUsd: 0,
      })
      .mockResolvedValueOnce({
        totalScore: 0.7,
        results: [
          { benchmarkId: "code-quality", score: 0.5, details: {}, timestamp: "t", costUsd: 0 },
        ] satisfies BenchmarkResult[],
        totalCostUsd: 0,
      });
    mockGenerateMutations.mockResolvedValueOnce([mutationFor("developer")]);

    await runOptimizerImpl(makeState(), makeConfig(), { maxIterations: 1 });

    const [, finalState] = mockedSaveState.mock.calls.at(-1)!;
    expect(finalState.evolution).toHaveLength(1);
    expect(finalState.evolution[0]!.accepted).toBe(true);
  });

  it("hybrid acceptance: agent degrades, overall improves slightly → reject", async () => {
    // baseline overall 0.5; post-mutation overall 0.55, agent-score 0.2
    // → weighted new = 0.7*0.2 + 0.3*0.55 = 0.305
    //   weighted baseline = 0.7*0.5 + 0.3*0.5 = 0.50 → REJECT
    benchmarkCallCount = 0;
    mockRunAllBenchmarks.mockReset();
    mockRunAllBenchmarks
      .mockResolvedValueOnce({
        totalScore: 0.5,
        results: [
          { benchmarkId: "code-quality", score: 0.5, details: {}, timestamp: "t", costUsd: 0 },
        ] satisfies BenchmarkResult[],
        totalCostUsd: 0,
      })
      .mockResolvedValueOnce({
        totalScore: 0.55,
        results: [
          { benchmarkId: "code-quality", score: 0.2, details: {}, timestamp: "t", costUsd: 0 },
        ] satisfies BenchmarkResult[],
        totalCostUsd: 0,
      });
    mockGenerateMutations.mockResolvedValueOnce([mutationFor("developer")]);

    await runOptimizerImpl(makeState(), makeConfig(), { maxIterations: 1 });

    const [, finalState] = mockedSaveState.mock.calls.at(-1)!;
    expect(finalState.evolution).toHaveLength(1);
    expect(finalState.evolution[0]!.accepted).toBe(false);
  });

  it("agentBaselines update on accept only (baselineScore stays put on reject)", async () => {
    // First iteration: accept (agent=0.9, overall=0.5)
    // Second iteration: reject (agent=0.1, overall=0.5)
    benchmarkCallCount = 0;
    mockRunAllBenchmarks.mockReset();
    mockRunAllBenchmarks
      // baseline
      .mockResolvedValueOnce({
        totalScore: 0.5,
        results: [{ benchmarkId: "cq", score: 0.5, details: {}, timestamp: "t", costUsd: 0 }],
        totalCostUsd: 0,
      })
      // mutation 1 — strong agent-specific improvement → accept
      .mockResolvedValueOnce({
        totalScore: 0.5,
        results: [{ benchmarkId: "cq", score: 0.9, details: {}, timestamp: "t", costUsd: 0 }],
        totalCostUsd: 0,
      })
      // mutation 2 — agent regression → reject (weighted < prior agent baseline 0.9)
      .mockResolvedValueOnce({
        totalScore: 0.5,
        results: [{ benchmarkId: "cq", score: 0.1, details: {}, timestamp: "t", costUsd: 0 }],
        totalCostUsd: 0,
      });
    mockGenerateMutations
      .mockResolvedValueOnce([mutationFor("developer")])
      .mockResolvedValueOnce([mutationFor("developer")]);

    await runOptimizerImpl(makeState(), makeConfig(), { maxIterations: 2 });

    const [, finalState] = mockedSaveState.mock.calls.at(-1)!;
    expect(finalState.evolution).toHaveLength(2);
    expect(finalState.evolution[0]!.accepted).toBe(true);
    expect(finalState.evolution[1]!.accepted).toBe(false);
  });

  // ── HIGH-05 blueprint verification gate ──────────────────────────────────

  it("rejects mutation with invalid blueprint without running benchmarks or savePromptVersion (HIGH-05)", async () => {
    const { savePromptVersion } = await import("../../src/self-improve/versioning.js");
    const mockedSavePromptVersion = vi.mocked(savePromptVersion);

    benchmarkCallCount = 0;
    benchmarkScores = [0.5];
    mockRunAllBenchmarks.mockClear();
    mockedSavePromptVersion.mockClear();

    // The mutation produces a blueprint whose systemPrompt is empty — the
    // verifier rejects via `system_prompt_too_short`.
    const invalidBlueprint: AgentBlueprint = {
      ...mockAgents[0]!,
      systemPrompt: "",
    };
    const originalBlueprint: AgentBlueprint = { ...mockAgents[0]! };

    mockGenerateMutations.mockResolvedValueOnce([
      {
        id: "mut-invalid-prompt",
        targetName: mockAgents[0]!.name,
        type: "agent_prompt",
        description: "empty-prompt mutation (invalid)",
        apply: () => invalidBlueprint,
        rollback: () => originalBlueprint,
      },
    ]);

    await runOptimizerImpl(makeState(), makeConfig(), { maxIterations: 1 });

    // Only the baseline benchmark runs — the rejected mutation must NOT
    // trigger another runAllBenchmarks call.
    expect(mockRunAllBenchmarks).toHaveBeenCalledTimes(1);

    // savePromptVersion is called only for initial baseline agents at startup
    // (once per registered agent), NEVER with the rejected mutation's blueprint.
    const calledWithInvalid = mockedSavePromptVersion.mock.calls.some(
      ([, bp]) => (bp as AgentBlueprint | undefined)?.systemPrompt === ""
    );
    expect(calledWithInvalid).toBe(false);

    // state.evolution carries exactly one rejected entry with the
    // `REJECTED: verification failed` diff prefix.
    const [, finalState] = mockedSaveState.mock.calls.at(-1)!;
    expect(finalState.evolution).toHaveLength(1);
    expect(finalState.evolution[0]!.accepted).toBe(false);
    expect(finalState.evolution[0]!.diff).toMatch(/^REJECTED: verification failed/);
    // Score unchanged on rejection — baseline is preserved.
    expect(finalState.evolution[0]!.scoreBefore).toBe(finalState.evolution[0]!.scoreAfter);
  });
});
