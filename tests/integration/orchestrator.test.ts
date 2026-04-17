import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createInitialState,
  loadState,
  type ProjectState,
} from "../../src/state/project-state.js";
import type { Config } from "../../src/utils/config.js";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DIR = join(tmpdir(), `ads-test-orchestrator-${process.pid}`);

// Mock the Agent SDK query function
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

// Mock retry to remove real delays in tests
vi.mock("../../src/utils/retry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/retry.js")>();
  return {
    ...actual,
    withRetry: async (fn: () => Promise<unknown>, options?: Partial<{ maxRetries: number }>, onRetry?: (attempt: number, error: Error, delayMs: number) => void) => {
      const maxRetries = options?.maxRetries ?? 3;
      let lastError: Error | undefined;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await fn();
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          lastError = error;
          if (!actual.isRetryableError(error) || attempt >= maxRetries) break;
          onRetry?.(attempt + 1, error, 0);
          // No delay in tests
        }
      }
      throw lastError ?? new Error("withRetry exhausted all attempts");
    },
  };
});

// Mock all phase handlers to avoid real SDK calls
vi.mock("../../src/phases/ideation.js", () => ({
  runIdeation: vi.fn(),
}));
vi.mock("../../src/phases/specification.js", () => ({
  runSpecification: vi.fn(),
}));
vi.mock("../../src/phases/architecture.js", () => ({
  runArchitecture: vi.fn(),
}));
vi.mock("../../src/phases/environment-setup.js", () => ({
  runEnvironmentSetup: vi.fn(),
}));
vi.mock("../../src/phases/development.js", () => ({
  runDevelopment: vi.fn(),
}));
vi.mock("../../src/phases/testing.js", () => ({
  runTesting: vi.fn(),
}));
vi.mock("../../src/phases/review.js", () => ({
  runReview: vi.fn(),
}));
vi.mock("../../src/phases/deployment.js", () => ({
  runDeployment: vi.fn(),
}));
vi.mock("../../src/phases/ab-testing.js", () => ({
  runABTesting: vi.fn(),
}));
vi.mock("../../src/phases/analysis.js", () => ({
  runAnalysis: vi.fn(),
}));
vi.mock("../../src/phases/monitoring.js", () => ({
  runMonitoring: vi.fn(),
}));

vi.mock("../../src/evaluation/grader.js", () => ({
  gradePhaseOutput: vi.fn(),
}));

const { runOrchestrator } = await import("../../src/orchestrator.js");
const { runIdeation } = await import("../../src/phases/ideation.js");
const { runSpecification } = await import("../../src/phases/specification.js");
const { runArchitecture } = await import("../../src/phases/architecture.js");
const { runEnvironmentSetup } = await import("../../src/phases/environment-setup.js");
const { gradePhaseOutput } = await import("../../src/evaluation/grader.js");

const mockedRunIdeation = vi.mocked(runIdeation);
const mockedRunSpecification = vi.mocked(runSpecification);
const mockedRunArchitecture = vi.mocked(runArchitecture);
const mockedRunEnvironmentSetup = vi.mocked(runEnvironmentSetup);
const mockedGradePhaseOutput = vi.mocked(gradePhaseOutput);

function makeConfig(): Config {
  return {
    model: "claude-sonnet-4-6",
    subagentModel: "claude-sonnet-4-6",
    selfImprove: { enabled: false, maxIterations: 50, nightlyOptimize: false },
    projectDir: TEST_DIR,
    stateDir: join(TEST_DIR, ".autonomous-dev"),
    memory: { enabled: false, maxDocuments: 500, maxDocumentSizeKb: 100 },
    rubrics: { enabled: false, maxIterations: 3 },
  };
}

describe("Orchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  it("runs through ideation → specification → architecture", async () => {
    const state = createInitialState("Build a todo app");
    const config = makeConfig();

    const specState: ProjectState = {
      ...state,
      currentPhase: "specification",
      spec: {
        summary: "A simple todo app",
        userStories: [
          {
            id: "US-001",
            title: "Add todo",
            description: "As a user, I want to add todos",
            acceptanceCriteria: ["Given the app, when I type and submit, then a todo appears"],
            priority: "must",
          },
        ],
        nonFunctionalRequirements: ["Performance: fast rendering"],
        domain: {
          classification: "web-application",
          specializations: [],
          requiredRoles: [],
          requiredMcpServers: [],
          techStack: ["typescript", "react"],
        },
      },
    };

    // Ideation → specification (valid per VALID_TRANSITIONS)
    // Note: return state with currentPhase still "ideation" — orchestrator handles the transition
    mockedRunIdeation.mockResolvedValueOnce({
      success: true,
      nextPhase: "specification",
      state: { ...specState, currentPhase: "ideation" },
    });

    // Specification → architecture
    mockedRunSpecification.mockImplementationOnce(async (s) => ({
      success: true,
      nextPhase: "architecture",
      state: { ...s, currentPhase: "specification" },
    }));

    mockedRunArchitecture.mockImplementationOnce(async (s) => ({
      success: true,
      state: { ...s, currentPhase: "architecture" },
      // No nextPhase — stops orchestration
    }));

    await runOrchestrator(state, config);

    expect(mockedRunIdeation).toHaveBeenCalledTimes(1);
    expect(mockedRunSpecification).toHaveBeenCalledTimes(1);
    expect(mockedRunArchitecture).toHaveBeenCalledTimes(1);
  });

  it("runs a single phase when singlePhase is specified", async () => {
    const state = createInitialState("Build a chat app");
    const config = makeConfig();

    mockedRunIdeation.mockResolvedValue({
      success: true,
      nextPhase: "architecture",
      state: { ...state, currentPhase: "specification" },
    });

    await runOrchestrator(state, config, undefined, "ideation");

    expect(mockedRunIdeation).toHaveBeenCalledTimes(1);
    expect(mockedRunArchitecture).not.toHaveBeenCalled();
  });

  it("handles phase failure and retries (stays in same phase)", async () => {
    const state = createInitialState("Build a blog");
    const config = makeConfig();

    // First call fails, second succeeds but stops
    mockedRunIdeation
      .mockResolvedValueOnce({
        success: false,
        state,
        error: "Failed to generate spec: no JSON in output",
      })
      .mockResolvedValueOnce({
        success: true,
        state: { ...state, currentPhase: "specification" },
        // No nextPhase — stops
      });

    await runOrchestrator(state, config);

    // Should have been called twice (retry after failure)
    expect(mockedRunIdeation).toHaveBeenCalledTimes(2);
  });

  it("stops on unhandled exception in phase handler", async () => {
    const state = createInitialState("Build something");
    const config = makeConfig();

    mockedRunIdeation.mockRejectedValue(new Error("Unexpected SDK error"));

    await runOrchestrator(state, config);

    // Retryable error: 1 initial + 3 retries = 4 calls
    expect(mockedRunIdeation).toHaveBeenCalledTimes(4);
  });

  // ── State persistence ─────────────────────────────────────────────────────

  it("populates completedPhases after each successful phase transition", async () => {
    const state = createInitialState("Build an app");
    const config = makeConfig();

    mockedRunIdeation.mockResolvedValueOnce({
      success: true,
      nextPhase: "specification",
      state: { ...state, currentPhase: "ideation" },
      costUsd: 0.04,
    });
    // Specification mock must pass through the accumulated state (with
    // completedPhases already containing "ideation"), not reset from outer scope.
    mockedRunSpecification.mockImplementationOnce(async (s) => ({
      success: true,
      nextPhase: "architecture",
      state: { ...s, currentPhase: "specification" },
    }));
    mockedRunArchitecture.mockImplementationOnce(async (s) => ({
      success: true,
      state: { ...s, currentPhase: "architecture" },
    }));

    await runOrchestrator(state, config);

    const saved = loadState(join(TEST_DIR, ".autonomous-dev"));
    expect(saved).not.toBeNull();
    // After ideation→specification and specification→architecture transitions, both are saved
    expect(saved!.completedPhases).toContain("ideation");
    expect(saved!.completedPhases).toContain("specification");
  });

  it("stores phaseResults with success flag and cost after each phase", async () => {
    const state = createInitialState("Build an app");
    const config = makeConfig();

    mockedRunIdeation.mockResolvedValueOnce({
      success: true,
      nextPhase: "specification",
      state: { ...state, currentPhase: "ideation" },
      costUsd: 0.04,
    });
    mockedRunSpecification.mockImplementationOnce(async (s) => ({
      success: true,
      nextPhase: "architecture",
      state: { ...s, currentPhase: "specification" },
    }));
    mockedRunArchitecture.mockImplementationOnce(async (s) => ({
      success: true,
      state: { ...s, currentPhase: "architecture" },
    }));

    await runOrchestrator(state, config);

    const saved = loadState(join(TEST_DIR, ".autonomous-dev"));
    expect(saved).not.toBeNull();
    expect(saved!.phaseResults["ideation"]).toBeDefined();
    expect(saved!.phaseResults["ideation"]!.success).toBe(true);
    expect(saved!.phaseResults["ideation"]!.costUsd).toBeCloseTo(0.04);
    expect(saved!.phaseResults["specification"]).toBeDefined();
    expect(saved!.phaseResults["specification"]!.success).toBe(true);
  });

  it("accumulates totalCostUsd across multiple phases", async () => {
    const state = createInitialState("Build an app");
    const config = makeConfig();

    mockedRunIdeation.mockResolvedValueOnce({
      success: true,
      nextPhase: "specification",
      state: { ...state, currentPhase: "ideation" },
      costUsd: 0.05,
    });
    mockedRunSpecification.mockImplementationOnce(async (s) => ({
      success: true,
      nextPhase: "architecture",
      state: { ...s, currentPhase: "specification" },
    }));
    mockedRunArchitecture.mockImplementationOnce(async (s) => ({
      success: true,
      nextPhase: "environment-setup",
      state: { ...s, currentPhase: "architecture" },
      costUsd: 0.10,
    }));
    // environment-setup returns no nextPhase — stops the loop
    mockedRunEnvironmentSetup.mockResolvedValue({
      success: true,
      state: { ...state, currentPhase: "environment-setup" },
    });

    await runOrchestrator(state, config);

    // State is saved during architecture→environment-setup transition
    // By that point totalCostUsd = ideation(0.05) + architecture(0.10) = 0.15
    const saved = loadState(join(TEST_DIR, ".autonomous-dev"));
    expect(saved).not.toBeNull();
    expect(saved!.totalCostUsd).toBeCloseTo(0.15);
  });

  // ── Rubric cachedSystemPrompt reuse (Stream 1) ────────────────────────────

  it("rubric loop passes the same PhaseContext object across retries (built once, reused)", async () => {
    const state = createInitialState("test rubric caching");
    const specState: ProjectState = {
      ...state,
      spec: {
        summary: "A",
        userStories: [],
        nonFunctionalRequirements: [],
        domain: {
          classification: "general",
          specializations: [],
          requiredRoles: [],
          requiredMcpServers: [],
          techStack: [],
        },
      },
    };

    // Capture the PhaseContext each iteration receives.
    // NOTE: must target a phase that HAS a rubric configured — ideation has none,
    // so use architecture.
    const iterCtxs: Array<{ cachedSystemPrompt?: string | undefined; rubricFeedback?: string | undefined } | undefined> = [];
    mockedRunArchitecture.mockImplementation(async (_s, _c, execCtx) => {
      iterCtxs.push(execCtx?.context);
      return { success: true, state: specState };
    });

    // Force two iterations: iter 1 → needs_revision, iter 2 → satisfied.
    mockedGradePhaseOutput
      .mockResolvedValueOnce({
        rubricResult: {
          rubricName: "Ideation Quality",
          scores: [{ criterionName: "x", score: 0.5, passed: false, feedback: "gap" }],
          verdict: "needs_revision",
          overallScore: 0.5,
          summary: "needs work",
          iteration: 1,
        },
        costUsd: 0.001,
      })
      .mockResolvedValueOnce({
        rubricResult: {
          rubricName: "Ideation Quality",
          scores: [{ criterionName: "x", score: 0.9, passed: true, feedback: "ok" }],
          verdict: "satisfied",
          overallScore: 0.9,
          summary: "good",
          iteration: 2,
        },
        costUsd: 0.001,
      });

    const config: Config = {
      ...makeConfig(),
      rubrics: { enabled: true, maxIterations: 3 },
    };

    await runOrchestrator(state, config, undefined, "architecture");

    // First-iteration result is captured from the initial `handler(state,...)`
    // call outside the loop; retries call the handler again. We expect at
    // least two captured contexts.
    expect(iterCtxs.length).toBeGreaterThanOrEqual(2);

    // cachedSystemPrompt is REFERENCE-EQUAL across iterations (build once,
    // reuse — without memory enabled both are `undefined`, which still
    // satisfies `.toBe()` reference equality).
    expect(iterCtxs[0]?.cachedSystemPrompt).toBe(iterCtxs[1]?.cachedSystemPrompt);

    // Rubric feedback is the expected per-iteration delta (first empty,
    // second populated after the needs_revision verdict).
    expect(iterCtxs[0]?.rubricFeedback).toBeUndefined();
    expect(iterCtxs[1]?.rubricFeedback).toBeDefined();
  });
});
