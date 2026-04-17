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
const { runEnvironmentSetup } = await import("../../src/phases/environment-setup.js");
const { runDevelopment } = await import("../../src/phases/development.js");
const { runReview } = await import("../../src/phases/review.js");
const { runDeployment } = await import("../../src/phases/deployment.js");
const { generateDashboard } = await import("../../src/dashboard/generate.js");

const mockedArchitecture = vi.mocked(runArchitecture);
const mockedEnvironmentSetup = vi.mocked(runEnvironmentSetup);
const mockedDevelopment = vi.mocked(runDevelopment);
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

  it("skips environment-setup in quick mode (PRODUCT.md §3)", async () => {
    // Regression: environment-setup is documented as optional in PRODUCT.md §3
    // but historically was missing from OPTIONAL_PHASES in both orchestrator.ts
    // and index.ts, so --quick ran it anyway. Now a single source of truth in
    // src/types/phases.ts includes environment-setup.
    const state: ProjectState = {
      ...createInitialState("Ship fast without env setup"),
      currentPhase: "environment-setup",
    };
    const config = makeConfig({ quickMode: true });

    // runDevelopment is the first required phase after env-setup — we stop the
    // orchestrator there by leaving the mock un-configured (returns undefined,
    // which causes the error branch to save state and break). We only care
    // that env-setup was skipped and the state transitioned to development.
    mockedDevelopment.mockResolvedValueOnce({
      success: true,
      state: {
        ...state,
        currentPhase: "development",
      },
    });

    await runOrchestrator(state, config);

    expect(mockedEnvironmentSetup).not.toHaveBeenCalled();

    const saved = loadState(config.stateDir);
    expect(saved?.currentPhase).toBe("development");
  });

  it("forces outer model to Opus when codexSubagents.enabled=true", async () => {
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
    // Start with a non-Opus outer model but enable Codex subagents + point
    // preflight at `node` so the check passes without Codex installed.
    // Re-importing the module so our command override threads through the
    // default-arg binding isn't practical here — we rely on the dryRun path
    // to skip the preflight call entirely, while still exercising the model-
    // coercion branch (Opus forcing happens before the dryRun gate).
    const config = makeConfig({
      model: "claude-sonnet-4-6",
      dryRun: true,
      codexSubagents: {
        enabled: true,
        model: "gpt-5.4",
        reasoningEffort: "xhigh",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        ephemeral: true,
        skipGitRepoCheck: true,
      },
    });

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

    expect(config.model).toBe("claude-opus-4-6");
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
