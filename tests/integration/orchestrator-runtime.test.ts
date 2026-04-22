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

  it("two concurrent runOrchestrator invocations each install their own Interrupter and both respond to SIGINT (HIGH-03)", async () => {
    const { _getInterrupterStackDepthForTest } = await import("../../src/orchestrator.js");

    // Two separate stateDirs so state writes don't collide.
    const DIR1 = join(TEST_DIR, "run1");
    const DIR2 = join(TEST_DIR, "run2");
    mkdirSync(DIR1, { recursive: true });
    mkdirSync(DIR2, { recursive: true });

    const baseSpec = {
      summary: "S",
      userStories: [],
      nonFunctionalRequirements: [],
      domain: {
        classification: "general",
        specializations: [],
        requiredRoles: [],
        requiredMcpServers: [],
        techStack: [],
      },
    };
    const state1: ProjectState = {
      ...createInitialState("concurrent run 1"),
      currentPhase: "architecture",
      spec: baseSpec,
    };
    const state2: ProjectState = {
      ...createInitialState("concurrent run 2"),
      currentPhase: "architecture",
      spec: baseSpec,
    };

    const config1: Config = makeConfig({
      projectDir: DIR1,
      stateDir: join(DIR1, ".autonomous-dev"),
    });
    const config2: Config = makeConfig({
      projectDir: DIR2,
      stateDir: join(DIR2, ".autonomous-dev"),
    });

    // Both mocked architecture handlers await the signal being aborted.
    const handlerInvoked = { run1: false, run2: false };
    const makeHandler =
      (label: "run1" | "run2") =>
      async (
        s: ProjectState,
        _c: Config,
        execCtx?: { signal?: AbortSignal } | undefined,
      ) => {
        handlerInvoked[label] = true;
        await new Promise<void>((resolve) => {
          if (!execCtx?.signal) return resolve();
          if (execCtx.signal.aborted) return resolve();
          execCtx.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { success: true, state: s };
      };

    mockedArchitecture.mockImplementationOnce(makeHandler("run1"));
    mockedArchitecture.mockImplementationOnce(makeHandler("run2"));

    // Start both runs in parallel.
    const p1 = runOrchestrator(state1, config1, undefined, "architecture");
    const p2 = runOrchestrator(state2, config2, undefined, "architecture");

    // Wait until both handlers have registered their abort listeners.
    await vi.waitFor(
      () => {
        expect(handlerInvoked.run1).toBe(true);
        expect(handlerInvoked.run2).toBe(true);
        expect(_getInterrupterStackDepthForTest()).toBe(2);
      },
      { timeout: 2000 },
    );

    // Fire SIGINT ONCE — each run's per-invocation listener must interrupt its own Interrupter.
    process.emit("SIGINT");

    // Both runs should complete (their handlers resolved once the signal aborted).
    await expect(Promise.all([p1, p2])).resolves.toBeDefined();

    // Stack is empty — each run popped its interrupter in finally.
    expect(_getInterrupterStackDepthForTest()).toBe(0);
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
