import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInitialState,
  loadState,
  type ProjectState,
} from "../../src/state/project-state.js";
import type { Config } from "../../src/utils/config.js";

const TEST_DIR = join(tmpdir(), `ads-test-orchestrator-runtime-${process.pid}`);

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
vi.mock("../../src/dashboard/generate.js", () => ({ generateDashboard: vi.fn() }));

const { runOrchestrator } = await import("../../src/orchestrator.js");
const { runArchitecture } = await import("../../src/phases/architecture.js");
const { runReview } = await import("../../src/phases/review.js");
const { runDeployment } = await import("../../src/phases/deployment.js");
const { generateDashboard } = await import("../../src/dashboard/generate.js");

const mockedArchitecture = vi.mocked(runArchitecture);
const mockedReview = vi.mocked(runReview);
const mockedDeployment = vi.mocked(runDeployment);
const mockedGenerateDashboard = vi.mocked(generateDashboard);

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    model: "claude-sonnet-4-6",
    subagentModel: "claude-sonnet-4-6",
    selfImprove: { enabled: false, maxIterations: 50, nightlyOptimize: false },
    projectDir: TEST_DIR,
    stateDir: join(TEST_DIR, ".autonomous-dev"),
    memory: { enabled: false, maxDocuments: 500, maxDocumentSizeKb: 100 },
    rubrics: { enabled: false, maxIterations: 3 },
    ...overrides,
  };
}

describe("Orchestrator runtime matrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    mockedGenerateDashboard.mockResolvedValue(undefined);
  });

  it("persists post-phase state when running a single phase", async () => {
    const state: ProjectState = {
      ...createInitialState("Build an app"),
      currentPhase: "architecture",
      spec: {
        summary: "A todo app",
        userStories: [],
        nonFunctionalRequirements: [],
        domain: {
          classification: "web-application",
          specializations: [],
          requiredRoles: [],
          requiredMcpServers: [],
          techStack: ["typescript"],
        },
      },
    };
    const config = makeConfig();

    mockedArchitecture.mockResolvedValueOnce({
      success: true,
      state: {
        ...state,
        architecture: {
          techStack: { language: "TypeScript" },
          components: [],
          apiContracts: "REST",
          databaseSchema: "todos",
          fileStructure: "src/",
        },
      },
    });

    await runOrchestrator(state, config, undefined, "architecture");

    const saved = loadState(config.stateDir);
    expect(saved).not.toBeNull();
    expect(saved?.architecture).toEqual({
      techStack: { language: "TypeScript" },
      components: [],
      apiContracts: "REST",
      databaseSchema: "todos",
      fileStructure: "src/",
    });
  });

  it("skips optional phases in quick mode and continues to the next required phase", async () => {
    const state: ProjectState = {
      ...createInitialState("Ship a release"),
      currentPhase: "review",
    };
    const config = makeConfig({ quickMode: true });

    mockedDeployment.mockResolvedValueOnce({
      success: true,
      state: {
        ...state,
        currentPhase: "staging",
      },
    });

    await runOrchestrator(state, config);

    expect(mockedReview).not.toHaveBeenCalled();
    expect(mockedDeployment).toHaveBeenCalledTimes(1);

    const saved = loadState(config.stateDir);
    expect(saved?.currentPhase).toBe("staging");
  });

  it("persists failed phase diagnostics without marking the phase complete", async () => {
    const state: ProjectState = {
      ...createInitialState("Build an app"),
      currentPhase: "architecture",
      spec: {
        summary: "A todo app",
        userStories: [],
        nonFunctionalRequirements: [],
        domain: {
          classification: "web-application",
          specializations: [],
          requiredRoles: [],
          requiredMcpServers: [],
          techStack: ["typescript"],
        },
      },
    };
    const config = makeConfig();

    mockedArchitecture.mockResolvedValueOnce({
      success: false,
      error: "Invalid architecture JSON: missing fileStructure",
      state,
    });

    await runOrchestrator(state, config, undefined, "architecture");

    const saved = loadState(config.stateDir);
    expect(saved).not.toBeNull();
    expect(saved?.currentPhase).toBe("architecture");
    expect(saved?.completedPhases).not.toContain("architecture");
    expect(saved?.phaseResults["architecture"]).toMatchObject({
      success: false,
      error: "Invalid architecture JSON: missing fileStructure",
    });
    expect(mockedGenerateDashboard).toHaveBeenCalledWith(
      config.stateDir,
      join(config.stateDir, "dashboard.html"),
    );

    const eventsDir = join(config.stateDir, "events");
    const eventFiles = readdirSync(eventsDir);
    expect(eventFiles.some((file) => file.endsWith(".summary.json"))).toBe(true);
  });
});
