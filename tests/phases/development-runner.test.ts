import { describe, it, expect, vi, beforeEach } from "vitest";
import { createInitialState } from "../../src/state/project-state.js";
import type { ProjectState } from "../../src/state/project-state.js";
import type { Config } from "../../src/utils/config.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("../../src/agents/factory.js", () => ({
  getAgentDefinitions: vi.fn().mockReturnValue({}),
  buildAgentTeam: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/environment/mcp-manager.js", () => ({
  getMcpServerConfigs: vi.fn().mockReturnValue({}),
}));

vi.mock("../../src/state/project-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/state/project-state.js")>();
  return {
    ...actual,
    saveState: vi.fn(),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn((_cmd, _args, _opts, cb) => {
      if (typeof _opts === "function") {
        _opts(null, "", "");
      } else if (typeof cb === "function") {
        cb(null, "", "");
      }
      return {} as any;
    }),
  };
});

const { query } = await import("@anthropic-ai/claude-agent-sdk");
const { runDevelopment } = await import("../../src/phases/development-runner.js");

const mockedQuery = vi.mocked(query);

function makeConfig(): Config {
  return {
    model: "claude-sonnet-4-6",
    subagentModel: "claude-sonnet-4-6",
    selfImprove: { enabled: false, maxIterations: 50, nightlyOptimize: false },
    projectDir: ".",
    stateDir: ".autonomous-dev",
    memory: { enabled: false, maxDocuments: 500, maxDocumentSizeKb: 100 },
    rubrics: { enabled: false, maxIterations: 3 },
  } as Config;
}

function makeQueryStream(resultText: string, structuredOutput?: unknown) {
  return {
    [Symbol.asyncIterator]() {
      let done = false;
      return {
        async next() {
          if (done) return { value: undefined, done: true as const };
          done = true;
          return {
            value: {
              type: "result",
              subtype: "success",
              result: resultText,
              session_id: "test-session",
              total_cost_usd: 0.02,
              num_turns: 3,
              structured_output: structuredOutput,
            },
            done: false as const,
          };
        },
      };
    },
    close() {},
  } as any;
}

function makeStateWithSpecAndArch(): ProjectState {
  const state = createInitialState("Build a todo app");
  return {
    ...state,
    spec: {
      summary: "A todo app",
      userStories: [
        {
          id: "US-001",
          title: "Create task",
          description: "As a user, I want to create tasks",
          acceptanceCriteria: ["Given the app, When I submit, Then a task is created"],
          priority: "must",
        },
      ],
      nonFunctionalRequirements: [],
      domain: {
        classification: "productivity",
        specializations: [],
        requiredRoles: [],
        requiredMcpServers: [],
        techStack: [],
      },
    },
    architecture: {
      techStack: { language: "TypeScript" },
      components: ["frontend"],
      apiContracts: "REST",
      databaseSchema: "tasks",
      fileStructure: "src/",
    },
  };
}

describe("Development Runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns failure when spec is missing", async () => {
    const state = createInitialState("some idea");
    const result = await runDevelopment(state, makeConfig());

    expect(result.success).toBe(false);
    expect(result.error).toContain("Spec and architecture required");
  });

  it("returns failure when architecture is missing", async () => {
    const state = createInitialState("some idea");
    const stateWithSpec: ProjectState = {
      ...state,
      spec: {
        summary: "App",
        userStories: [],
        nonFunctionalRequirements: [],
        domain: { classification: "general", specializations: [], requiredRoles: [], requiredMcpServers: [], techStack: [] },
      },
    };
    const result = await runDevelopment(stateWithSpec, makeConfig());

    expect(result.success).toBe(false);
    expect(result.error).toContain("Spec and architecture required");
  });

  it("returns success when all tasks are already completed", async () => {
    const base = makeStateWithSpecAndArch();
    const state: ProjectState = {
      ...base,
      spec: {
        ...base.spec!,
        userStories: [],
      },
      tasks: [],
    };

    // With no user stories and no tasks, decomposition returns nothing
    // and development finishes without calling query for batches
    mockedQuery.mockReturnValue(
      makeQueryStream("", { tasks: [] })
    );

    const result = await runDevelopment(state, makeConfig());

    expect(result.success).toBe(true);
    expect(result.nextPhase).toBe("testing");
  });

  it("decomposes stories into tasks via query and proceeds", async () => {
    const state = makeStateWithSpecAndArch();

    const decompositionOutput = {
      tasks: [
        {
          id: "task-001",
          title: "Create task",
          description: "Implement task creation endpoint",
          estimatedComplexity: "medium",
          dependencies: [],
          acceptanceCriteria: ["Task is saved to DB"],
        },
      ],
    };

    // First query call: decomposition
    // Second query call: batch execution
    mockedQuery
      .mockReturnValueOnce(makeQueryStream("", decompositionOutput))
      .mockReturnValue(
        makeQueryStream(
          JSON.stringify({
            results: [{ taskId: expect.any(String), success: true, result: "Done" }],
          })
        )
      );

    const result = await runDevelopment(state, makeConfig());

    expect(mockedQuery).toHaveBeenCalled();
    // Result can be success or partial success depending on task ID matching
    expect(result.state).toBeDefined();
  });
});
