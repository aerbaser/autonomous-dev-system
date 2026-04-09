import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createInitialState,
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
vi.mock("../../src/phases/monitoring.js", () => ({
  runMonitoring: vi.fn(),
}));

const { runOrchestrator } = await import("../../src/orchestrator.js");
const { runIdeation } = await import("../../src/phases/ideation.js");
const { runArchitecture } = await import("../../src/phases/architecture.js");

const mockedRunIdeation = vi.mocked(runIdeation);
const mockedRunArchitecture = vi.mocked(runArchitecture);

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

    // Specification is now a pass-through (no LLM call), transitions straight to architecture
    mockedRunArchitecture.mockResolvedValue({
      success: true,
      state: { ...specState, currentPhase: "architecture" },
      // No nextPhase — stops orchestration
    });

    await runOrchestrator(state, config);

    // ideation called once; specification is a pass-through (no runIdeation call)
    expect(mockedRunIdeation).toHaveBeenCalledTimes(1);
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
});
