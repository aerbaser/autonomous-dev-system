import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectState } from "../../src/state/project-state.js";
import type { Config } from "../../src/utils/config.js";

const mockRunOptimizer = vi.fn();
const mockGenerateDashboard = vi.fn();

vi.mock("../../src/self-improve/optimizer.js", () => ({
  runOptimizer: (...args: unknown[]) => mockRunOptimizer(...args),
}));

vi.mock("../../src/dashboard/generate.js", () => ({
  generateDashboard: (...args: unknown[]) => mockGenerateDashboard(...args),
}));

const { runNightlyMaintenance } = await import("../../src/nightly/nightly-runner.js");

function makeState(): ProjectState {
  return {
    id: "nightly-state",
    idea: "Maintain project",
    currentPhase: "development",
    spec: null,
    architecture: null,
    environment: null,
    agents: [],
    tasks: [],
    completedPhases: [],
    phaseResults: {},
    deployments: [],
    abTests: [],
    evolution: [],
    checkpoints: [],
    baselineScore: 0.5,
    totalCostUsd: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    model: "claude-sonnet-4-6",
    subagentModel: "claude-sonnet-4-6",
    selfImprove: { enabled: true, maxIterations: 9, nightlyOptimize: true },
    projectDir: ".",
    stateDir: ".autonomous-dev",
    autonomousMode: true,
    maxTurns: {
      default: 50,
      decomposition: 3,
      development: 60,
      qualityFix: 30,
      testing: 30,
      review: 20,
      deployment: 20,
      monitoring: 10,
      ideation: 10,
      architecture: 10,
      abTesting: 10,
      stackResearch: 15,
      domainAnalysis: 5,
      ossScan: 10,
    },
    dryRun: false,
    quickMode: false,
    confirmSpec: false,
    memory: { enabled: false, maxDocuments: 500, maxDocumentSizeKb: 100 },
    rubrics: { enabled: false, maxIterations: 3 },
    ...overrides,
  } as Config;
}

describe("runNightlyMaintenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs optimize and dashboard when nightly optimization is enabled", async () => {
    const state = makeState();
    const config = makeConfig();

    const result = await runNightlyMaintenance(state, config);

    expect(mockRunOptimizer).toHaveBeenCalledWith(state, config, { maxIterations: 9 });
    expect(mockGenerateDashboard).toHaveBeenCalledWith(".autonomous-dev", ".autonomous-dev/dashboard.html");
    expect(result.status).toBe("passed");
    expect(result.steps).toEqual([
      expect.objectContaining({ name: "optimize", status: "passed" }),
      expect.objectContaining({ name: "dashboard", status: "passed" }),
    ]);
    expect(result.dashboardPath).toBe(".autonomous-dev/dashboard.html");
  });

  it("allows overriding nightly optimize iterations", async () => {
    const state = makeState();
    const config = makeConfig();

    await runNightlyMaintenance(state, config, { maxIterations: 2 });

    expect(mockRunOptimizer).toHaveBeenCalledWith(state, config, { maxIterations: 2 });
  });

  it("skips optimization deterministically when nightly optimize is disabled", async () => {
    const state = makeState();
    const config = makeConfig({
      selfImprove: { enabled: true, maxIterations: 9, nightlyOptimize: false },
    });

    const result = await runNightlyMaintenance(state, config);

    expect(mockRunOptimizer).not.toHaveBeenCalled();
    expect(mockGenerateDashboard).toHaveBeenCalledTimes(1);
    expect(result.steps[0]).toEqual(
      expect.objectContaining({
        name: "optimize",
        status: "skipped",
      }),
    );
    expect(result.status).toBe("passed");
  });

  it("keeps going to dashboard when optimization fails", async () => {
    const state = makeState();
    const config = makeConfig();
    mockRunOptimizer.mockRejectedValueOnce(new Error("optimizer exploded"));

    const result = await runNightlyMaintenance(state, config);

    expect(mockGenerateDashboard).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("failed");
    expect(result.steps).toEqual([
      expect.objectContaining({ name: "optimize", status: "failed", detail: "optimizer exploded" }),
      expect.objectContaining({ name: "dashboard", status: "passed" }),
    ]);
  });

  it("returns a skipped result when all nightly steps are disabled by options", async () => {
    const result = await runNightlyMaintenance(makeState(), makeConfig(), {
      skipOptimize: true,
      skipDashboard: true,
    });

    expect(mockRunOptimizer).not.toHaveBeenCalled();
    expect(mockGenerateDashboard).not.toHaveBeenCalled();
    expect(result.status).toBe("skipped");
    expect(result.steps).toEqual([
      expect.objectContaining({ name: "optimize", status: "skipped" }),
      expect.objectContaining({ name: "dashboard", status: "skipped" }),
    ]);
  });
});
