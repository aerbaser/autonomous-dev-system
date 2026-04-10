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

const TEST_DIR = join(tmpdir(), `ads-test-pipeline-${process.pid}`);

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("../../src/utils/retry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/retry.js")>();
  return {
    ...actual,
    withRetry: async (fn: () => Promise<unknown>) => fn(),
  };
});

vi.mock("../../src/phases/ideation.js", () => ({ runIdeation: vi.fn() }));
vi.mock("../../src/phases/architecture.js", () => ({ runArchitecture: vi.fn() }));
vi.mock("../../src/phases/environment-setup.js", () => ({ runEnvironmentSetup: vi.fn() }));
vi.mock("../../src/phases/development.js", () => ({ runDevelopment: vi.fn() }));
vi.mock("../../src/phases/testing.js", () => ({ runTesting: vi.fn() }));
vi.mock("../../src/phases/review.js", () => ({ runReview: vi.fn() }));
vi.mock("../../src/phases/deployment.js", () => ({ runDeployment: vi.fn() }));
vi.mock("../../src/phases/ab-testing.js", () => ({ runABTesting: vi.fn() }));
vi.mock("../../src/phases/monitoring.js", () => ({ runMonitoring: vi.fn() }));

const { runOrchestrator, getInterrupter } = await import("../../src/orchestrator.js");
const { runIdeation } = await import("../../src/phases/ideation.js");
const { runArchitecture } = await import("../../src/phases/architecture.js");
const { runEnvironmentSetup } = await import("../../src/phases/environment-setup.js");

const mockedIdeation = vi.mocked(runIdeation);
const mockedArchitecture = vi.mocked(runArchitecture);
const mockedEnvSetup = vi.mocked(runEnvironmentSetup);

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

const specFixture = {
  summary: "A simple todo app",
  userStories: [
    {
      id: "US-001",
      title: "Add todo",
      description: "As a user, I want to add todos",
      acceptanceCriteria: ["Given the app, when I type and submit, then a todo appears"],
      priority: "must" as const,
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
};

describe("Pipeline E2E", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getInterrupter().reset();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  it("runs ideation → specification → architecture → environment-setup", async () => {
    const state = createInitialState("Build a todo app");
    const config = makeConfig();

    mockedIdeation.mockResolvedValueOnce({
      success: true,
      nextPhase: "specification",
      state: { ...state, currentPhase: "ideation", spec: specFixture },
    });

    mockedArchitecture.mockResolvedValueOnce({
      success: true,
      nextPhase: "environment-setup",
      state: {
        ...state,
        currentPhase: "architecture",
        spec: specFixture,
        architecture: {
          techStack: { language: "TypeScript", framework: "React" },
          components: ["TodoList", "TodoItem"],
          apiContracts: "",
          databaseSchema: "",
          fileStructure: "src/",
        },
      },
    });

    mockedEnvSetup.mockResolvedValueOnce({
      success: true,
      state: { ...state, currentPhase: "environment-setup", spec: specFixture },
      // No nextPhase — stops orchestration
    });

    await runOrchestrator(state, config);

    expect(mockedIdeation).toHaveBeenCalledTimes(1);
    expect(mockedArchitecture).toHaveBeenCalledTimes(1);
    expect(mockedEnvSetup).toHaveBeenCalledTimes(1);
    expect(mockedArchitecture.mock.calls[0]?.[0].spec).toEqual(specFixture);
    expect(mockedEnvSetup.mock.calls[0]?.[0].architecture).toEqual({
      techStack: { language: "TypeScript", framework: "React" },
      components: ["TodoList", "TodoItem"],
      apiContracts: "",
      databaseSchema: "",
      fileStructure: "src/",
    });
  });

  it("saves state to disk after each phase", async () => {
    const state = createInitialState("Build a todo app");
    const config = makeConfig();

    mockedIdeation.mockResolvedValueOnce({
      success: true,
      nextPhase: "specification",
      state: { ...state, currentPhase: "ideation", spec: specFixture },
    });

    mockedArchitecture.mockResolvedValueOnce({
      success: true,
      state: { ...state, currentPhase: "architecture", spec: specFixture },
    });

    await runOrchestrator(state, config);

    const savedState = loadState(config.stateDir);
    expect(savedState).not.toBeNull();
    expect(savedState!.currentPhase).toBe("architecture");
    expect(savedState!.spec).toEqual(specFixture);
    expect(savedState!.completedPhases).toContain("ideation");
    expect(savedState!.completedPhases).toContain("specification");
    expect(savedState!.phaseResults["ideation"]?.success).toBe(true);
    expect(savedState!.phaseResults["specification"]?.success).toBe(true);
  });

  it("stops gracefully on SIGINT (requestShutdown)", async () => {
    const state = createInitialState("Build a todo app");
    const config = makeConfig();

    // After ideation completes, trigger shutdown before next phase
    mockedIdeation.mockImplementation(async (s) => {
      getInterrupter().requestShutdown();
      return {
        success: true,
        nextPhase: "specification",
        state: { ...s, currentPhase: "ideation", spec: specFixture },
      };
    });

    await runOrchestrator(state, config);

    // Ideation runs but architecture should NOT be called (shutdown between phases)
    expect(mockedIdeation).toHaveBeenCalledTimes(1);
    expect(mockedArchitecture).not.toHaveBeenCalled();

    // State should be saved
    const savedState = loadState(config.stateDir);
    expect(savedState).not.toBeNull();
  });

  it("resumes from mid-pipeline state", async () => {
    const config = makeConfig();

    // Create state as if ideation and specification already completed
    const midState: ProjectState = {
      ...createInitialState("Build a todo app"),
      currentPhase: "architecture",
      spec: specFixture,
    };

    mockedArchitecture.mockResolvedValueOnce({
      success: true,
      state: { ...midState, currentPhase: "architecture" },
    });

    await runOrchestrator(midState, config);

    // Should NOT call ideation (we're past it)
    expect(mockedIdeation).not.toHaveBeenCalled();
    // Should call architecture (current phase)
    expect(mockedArchitecture).toHaveBeenCalledTimes(1);
    expect(mockedArchitecture.mock.calls[0]?.[0].spec).toEqual(specFixture);
  });
});
