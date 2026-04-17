/**
 * Phase 3+8 integration: verify the auxiliary-loop profile gate prevents
 * the rubric grader from firing under the default `minimal` profile, and
 * re-enables it when the profile is switched to `debug`/`nightly` or when
 * `config.rubrics.enabled` is explicitly flipped on (the `--enable-rubrics`
 * CLI override path).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createInitialState,
  type ProjectState,
} from "../../src/state/project-state.js";
import type { Config } from "../../src/utils/config.js";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DIR = join(tmpdir(), `ads-test-aux-profile-${process.pid}`);

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

// Mock every phase handler so the orchestrator loop is controlled.
vi.mock("../../src/phases/ideation.js", () => ({ runIdeation: vi.fn() }));
vi.mock("../../src/phases/architecture.js", () => ({ runArchitecture: vi.fn() }));
vi.mock("../../src/phases/environment-setup.js", () => ({ runEnvironmentSetup: vi.fn() }));
vi.mock("../../src/phases/development.js", () => ({ runDevelopment: vi.fn() }));
vi.mock("../../src/phases/testing.js", () => ({ runTesting: vi.fn() }));
vi.mock("../../src/phases/review.js", () => ({ runReview: vi.fn() }));
vi.mock("../../src/phases/deployment.js", () => ({ runDeployment: vi.fn() }));
vi.mock("../../src/phases/ab-testing.js", () => ({ runABTesting: vi.fn() }));
vi.mock("../../src/phases/monitoring.js", () => ({ runMonitoring: vi.fn() }));

// Spy on the grader so we can assert whether the orchestrator invoked it.
vi.mock("../../src/evaluation/grader.js", () => ({
  gradePhaseOutput: vi.fn().mockResolvedValue({
    rubricResult: {
      rubricName: "development",
      scores: [],
      verdict: "satisfied",
      overallScore: 1,
      summary: "",
      iteration: 1,
    },
    costUsd: 0.001,
  }),
}));

const { runOrchestrator } = await import("../../src/orchestrator.js");
const { runIdeation } = await import("../../src/phases/ideation.js");
const { runArchitecture } = await import("../../src/phases/architecture.js");
const { gradePhaseOutput } = await import("../../src/evaluation/grader.js");

const mockedIdeation = vi.mocked(runIdeation);
const mockedArchitecture = vi.mocked(runArchitecture);
const mockedGrader = vi.mocked(gradePhaseOutput);

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    model: "claude-sonnet-4-6",
    subagentModel: "claude-sonnet-4-6",
    selfImprove: { enabled: false, maxIterations: 50, nightlyOptimize: false },
    projectDir: TEST_DIR,
    stateDir: join(TEST_DIR, ".autonomous-dev"),
    memory: { enabled: false, maxDocuments: 500, maxDocumentSizeKb: 100 },
    rubrics: { enabled: false, maxIterations: 3 },
    autonomousMode: true,
    maxTurns: {} as Config["maxTurns"],
    dryRun: false,
    quickMode: false,
    confirmSpec: false,
    maxParallelBatches: 3,
    roles: {},
    retryPolicy: {
      provider_limit: "checkpoint",
      verification_failed: { maxAttempts: 2 },
      identical_failure_abort: true,
    },
    developmentCoordinator: { enabled: false },
    auxiliaryProfile: "minimal",
    ...overrides,
  } as Config;
}

async function runSinglePhaseWithRubric(config: Config): Promise<void> {
  const state: ProjectState = createInitialState("Build a thing");
  mockedArchitecture.mockResolvedValueOnce({
    success: true,
    state: { ...state, currentPhase: "architecture" },
    costUsd: 0.01,
  });
  // Run single phase so orchestrator doesn't transition further and we don't
  // need to stub every downstream phase.
  await runOrchestrator(state, config, undefined, "architecture");
}

describe("auxiliary profile gate — rubric grader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    mockedIdeation.mockReset();
    mockedArchitecture.mockReset();
    mockedGrader.mockClear();
  });

  it("minimal profile does NOT invoke the grader (default path)", async () => {
    const config = makeConfig({ auxiliaryProfile: "minimal" });
    await runSinglePhaseWithRubric(config);
    expect(mockedGrader).not.toHaveBeenCalled();
  });

  it("minimal profile + rubrics.enabled=true (CLI override) DOES invoke the grader", async () => {
    const config = makeConfig({
      auxiliaryProfile: "minimal",
      rubrics: { enabled: true, maxIterations: 3 },
    });
    await runSinglePhaseWithRubric(config);
    expect(mockedGrader).toHaveBeenCalled();
  });

  it("nightly profile invokes the grader without needing rubrics.enabled", async () => {
    const config = makeConfig({
      auxiliaryProfile: "nightly",
      rubrics: { enabled: false, maxIterations: 3 },
    });
    await runSinglePhaseWithRubric(config);
    expect(mockedGrader).toHaveBeenCalled();
  });

  it("debug profile only invokes the grader when rubrics.enabled=true", async () => {
    const off = makeConfig({ auxiliaryProfile: "debug", rubrics: { enabled: false, maxIterations: 3 } });
    await runSinglePhaseWithRubric(off);
    expect(mockedGrader).not.toHaveBeenCalled();
    mockedGrader.mockClear();

    const on = makeConfig({ auxiliaryProfile: "debug", rubrics: { enabled: true, maxIterations: 3 } });
    await runSinglePhaseWithRubric(on);
    expect(mockedGrader).toHaveBeenCalled();
  });
});
