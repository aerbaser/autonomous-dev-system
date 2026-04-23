import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createInitialState,
  loadState,
  type ProjectState,
} from "../../src/state/project-state.js";
import type { Config } from "../../src/utils/config.js";

const TEST_DIR = join(tmpdir(), `ads-test-backloop-e2e-${process.pid}`);

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
vi.mock("../../src/phases/specification.js", () => ({ runSpecification: vi.fn() }));
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
const { runDevelopment } = await import("../../src/phases/development.js");
const { runTesting } = await import("../../src/phases/testing.js");
const { runReview } = await import("../../src/phases/review.js");

const mockedDevelopment = vi.mocked(runDevelopment);
const mockedTesting = vi.mocked(runTesting);
const mockedReview = vi.mocked(runReview);

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    model: "claude-sonnet-4-6",
    subagentModel: "claude-sonnet-4-6",
    selfImprove: { enabled: false, maxIterations: 50, nightlyOptimize: false },
    projectDir: TEST_DIR,
    stateDir: join(TEST_DIR, ".autonomous-dev"),
    memory: { enabled: false, maxDocuments: 500, maxDocumentSizeKb: 100, layers: { enabled: false } },
    rubrics: { enabled: false, maxIterations: 3 },
    ...overrides,
  } as Config;
}

function makeStateAtDevelopment(): ProjectState {
  const completedUpToDev: ProjectState["currentPhase"] = "development";
  return {
    ...createInitialState("toy idea"),
    currentPhase: completedUpToDev,
    spec: {
      summary: "s",
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
    architecture: {
      techStack: { language: "ts" },
      components: [{ name: "core", description: "c", dependencies: [] }],
      apiContracts: "—",
      databaseSchema: "—",
      fileStructure: "src/",
    },
    completedPhases: ["ideation", "specification", "architecture", "environment-setup"],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

describe("backloop E2E: testing ↔ development ↔ review", () => {
  it(
    "persists phaseAttempts on every re-entry and increments backloopCounts on legal backloop",
    async () => {
      // Sequence: dev → testing → dev → testing → review
      mockedDevelopment.mockImplementation(async (s) => ({
        success: true,
        state: s,
        nextPhase: "testing",
      }));

      let testingCall = 0;
      mockedTesting.mockImplementation(async (s) => {
        testingCall += 1;
        return {
          success: true,
          state: s,
          // First time: ask for a backloop. Second time: proceed to review.
          nextPhase: testingCall === 1 ? "development" : "review",
          costUsd: 0.05,
        };
      });

      mockedReview.mockImplementation(async (s) => ({
        success: true,
        state: s,
        nextPhase: "staging",
        costUsd: 0.02,
      }));

      // Short-circuit the rest of the pipeline so it doesn't try to run staging+.
      // Orchestrator breaks the loop on "No transition specified" — achieved by
      // leaving the mock un-configured below.

      const state = makeStateAtDevelopment();
      const config = makeConfig();

      await runOrchestrator(state, config);

      expect(mockedDevelopment).toHaveBeenCalledTimes(2);
      expect(mockedTesting).toHaveBeenCalledTimes(2);
      expect(mockedReview).toHaveBeenCalledTimes(1);

      const saved = loadState(config.stateDir);
      expect(saved).not.toBeNull();

      // phaseAttempts: development twice, testing twice, review once
      expect(saved!.phaseAttempts["development"]?.length).toBe(2);
      expect(saved!.phaseAttempts["testing"]?.length).toBe(2);
      expect(saved!.phaseAttempts["review"]?.length).toBe(1);

      // backloopCounts tracks EVERY re-entry into a phase already in
      // completedPhases (symmetric — the livelock guard doesn't care
      // whether the target is "before" or "after" the source).
      // - Initial development transition → testing: testing never entered
      //   before, so no backloop.
      // - testing asks for development: development was already completed
      //   → testing->development = 1.
      // - development re-entered, transitions to testing again: testing
      //   was already completed → development->testing = 1.
      // - testing transitions to review: review never entered before →
      //   no backloop.
      expect(saved!.backloopCounts["testing->development"]).toBe(1);
      expect(saved!.backloopCounts["development->testing"]).toBe(1);
      expect(saved!.backloopCounts["testing->review"]).toBeUndefined();
      expect(saved!.backloopCounts["review->staging"]).toBeUndefined();

      // phaseResults keeps the LATEST attempt (last-write-wins semantics).
      expect(saved!.phaseResults["testing"]?.success).toBe(true);
      expect(saved!.phaseResults["development"]?.success).toBe(true);
    },
    15000,
  );

  it(
    "accumulates multiple backloops when testing asks for development repeatedly",
    async () => {
      mockedDevelopment.mockImplementation(async (s) => ({
        success: true,
        state: s,
        nextPhase: "testing",
      }));

      let testingCall = 0;
      mockedTesting.mockImplementation(async (s) => {
        testingCall += 1;
        return {
          success: true,
          state: s,
          nextPhase: testingCall < 3 ? "development" : "review",
          costUsd: 0.01,
        };
      });

      mockedReview.mockImplementation(async (s) => ({
        success: true,
        state: s,
        nextPhase: "staging",
      }));

      const state = makeStateAtDevelopment();
      const config = makeConfig();

      await runOrchestrator(state, config);

      const saved = loadState(config.stateDir);
      // Two backloops testing -> development (after the 1st and 2nd testing runs)
      expect(saved!.backloopCounts["testing->development"]).toBe(2);
      // development runs 3 times total (initial + 2 returns)
      expect(saved!.phaseAttempts["development"]?.length).toBe(3);
      expect(saved!.phaseAttempts["testing"]?.length).toBe(3);
    },
    15000,
  );

  it(
    "livelock guard halts the run when a backloop pair exceeds GLOBAL_MAX_BACKLOOPS",
    async () => {
      // testing always asks to go back to development — infinite livelock.
      // The orchestrator must deny the 6th backloop and break.
      mockedDevelopment.mockImplementation(async (s) => ({
        success: true,
        state: s,
        nextPhase: "testing",
      }));

      mockedTesting.mockImplementation(async (s) => ({
        success: true,
        state: s,
        nextPhase: "development",
        costUsd: 0.01,
      }));

      const state = makeStateAtDevelopment();
      const config = makeConfig();

      await runOrchestrator(state, config);

      const saved = loadState(config.stateDir);
      // GLOBAL_MAX_BACKLOOPS = 5 so testing->development caps at 5.
      expect(saved!.backloopCounts["testing->development"]).toBe(5);
      // Review is never reached — the livelock halts the run first.
      expect(mockedReview).not.toHaveBeenCalled();
    },
    15000,
  );
});
