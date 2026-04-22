import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInitialState,
  saveCheckpoint,
  saveState,
  type PhaseCheckpoint,
  type ProjectState,
} from "../../src/state/project-state.js";
import { saveSessions, setSession } from "../../src/state/session-store.js";
import type { Config } from "../../src/utils/config.js";

const TEST_DIR = join(tmpdir(), `ads-test-orchestrator-autonomy-${process.pid}`);

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("../../src/utils/retry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/retry.js")>();
  return {
    ...actual,
    withRetry: async (
      fn: () => Promise<unknown>,
      options?: Partial<{ maxRetries: number }>,
      onRetry?: (attempt: number, error: Error, delayMs: number) => void,
    ) => {
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
        }
      }
      throw lastError ?? new Error("withRetry exhausted all attempts");
    },
  };
});

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

const { runOrchestrator } = await import("../../src/orchestrator.js");
const { runIdeation } = await import("../../src/phases/ideation.js");
const { runSpecification } = await import("../../src/phases/specification.js");
const { runArchitecture } = await import("../../src/phases/architecture.js");

const mockedRunIdeation = vi.mocked(runIdeation);
const mockedRunSpecification = vi.mocked(runSpecification);
const mockedRunArchitecture = vi.mocked(runArchitecture);

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

function makeSpecState(base: ProjectState): ProjectState {
  return {
    ...base,
    currentPhase: "ideation",
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
}

async function runWithTTY(
  value: boolean,
  fn: () => Promise<void>,
): Promise<void> {
  const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
  const original = Object.getOwnPropertyDescriptor(stdin, "isTTY");
  Object.defineProperty(stdin, "isTTY", {
    value,
    configurable: true,
  });
  try {
    await fn();
  } finally {
    if (original) {
      Object.defineProperty(stdin, "isTTY", original);
    } else {
      delete (stdin as { isTTY?: boolean }).isTTY;
    }
  }
}

describe("Orchestrator autonomy hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stops after budget is exceeded without advancing to the next phase", async () => {
    const state = createInitialState("Build a todo app");
    const config = makeConfig({ budgetUsd: 0.01 });

    mockedRunIdeation.mockResolvedValueOnce({
      success: true,
      nextPhase: "specification",
      state: makeSpecState(state),
      costUsd: 0.05,
    });

    await runOrchestrator(state, config);

    expect(mockedRunIdeation).toHaveBeenCalledTimes(1);
    expect(mockedRunArchitecture).not.toHaveBeenCalled();

    const saved = JSON.parse(readFileSync(join(TEST_DIR, ".autonomous-dev", "state.json"), "utf-8")) as ProjectState;
    expect(saved.phaseResults.ideation.success).toBe(true);
    expect(saved.totalCostUsd).toBeCloseTo(0.05);
  });

  it("passes checkpoint and session context into a resumed phase", async () => {
    const state = saveCheckpoint(
      {
        ...createInitialState("Resume a project"),
        currentPhase: "architecture",
      },
      {
        phase: "architecture",
        completedTasks: ["task-1"],
        pendingTasks: ["task-2"],
        timestamp: new Date().toISOString(),
        metadata: { costUsd: 1.25, success: true },
      } satisfies PhaseCheckpoint,
    );
    const config = makeConfig();

    saveState(config.stateDir, state);
    saveSessions(
      config.stateDir,
      setSession(
        { sessions: {} },
        "architecture",
        "session-arch-123",
      ),
    );

    mockedRunArchitecture.mockResolvedValueOnce({
      success: true,
      state: { ...state, currentPhase: "architecture" },
    });

    await runOrchestrator(state, config, "session-arch-123", "architecture");

    expect(mockedRunArchitecture).toHaveBeenCalledTimes(1);
    const execCtx = mockedRunArchitecture.mock.calls[0]?.[2];
    expect(execCtx?.sessionId).toBe("session-arch-123");
    expect(execCtx?.checkpoint?.phase).toBe("architecture");
    expect(execCtx?.checkpoint?.completedTasks).toEqual(["task-1"]);
    expect(execCtx?.checkpoint?.pendingTasks).toEqual(["task-2"]);
  });

  it("waits for confirmation in interactive confirm-spec mode", async () => {
    const state = createInitialState("Build a todo app");
    const config = makeConfig({ confirmSpec: true });

    mockedRunIdeation.mockResolvedValueOnce({
      success: true,
      nextPhase: "specification",
      state: makeSpecState(state),
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

    const onceSpy = vi.spyOn(process.stdin, "once").mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
      if (event === "data") {
        queueMicrotask(() => listener(Buffer.from("y\n")));
      }
      return process.stdin;
    });

    await runWithTTY(true, async () => {
      await runOrchestrator(state, config);
    });

    expect(onceSpy).toHaveBeenCalledWith("data", expect.any(Function));
  });

  it("does not block unattended runs in non-interactive confirm-spec mode", async () => {
    const state = createInitialState("Build a todo app");
    const config = makeConfig({ confirmSpec: true });

    mockedRunIdeation.mockResolvedValueOnce({
      success: true,
      nextPhase: "specification",
      state: makeSpecState(state),
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

    const onceSpy = vi.spyOn(process.stdin, "once");

    await runWithTTY(false, async () => {
      await runOrchestrator(state, config);
    });

    expect(onceSpy).not.toHaveBeenCalled();
    expect(mockedRunArchitecture).toHaveBeenCalledTimes(1);
  });
});
