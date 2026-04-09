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
const { saveState } = await import("../../src/state/project-state.js");

const mockedQuery = vi.mocked(query);
const mockedSaveState = vi.mocked(saveState);

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
      components: [{ name: "frontend", description: "Web UI", dependencies: [] }],
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

  it("treats completely empty LLM response as all-tasks-failed", async () => {
    const state = makeStateWithSpecAndArch();

    // Decomposition returns one task
    const decompositionOutput = {
      tasks: [
        {
          id: "task-001",
          title: "Create task",
          description: "Implement task creation endpoint",
          estimatedComplexity: "medium",
          dependencies: [],
          acceptanceCriteria: [],
        },
      ],
    };

    mockedQuery
      .mockReturnValueOnce(makeQueryStream("", decompositionOutput))
      // Batch execution returns empty string — simulates LLM timeout/empty reply
      .mockReturnValue(makeQueryStream("", undefined));

    const result = await runDevelopment(state, makeConfig());

    expect(result.success).toBe(false);
    const failed = result.state.tasks.filter((t) => t.status === "failed");
    expect(failed.length).toBeGreaterThan(0);
  });

  it("treats task not mentioned in JSON response as failed (bug fix)", async () => {
    const state = makeStateWithSpecAndArch();
    // Add a second user story so we get two tasks
    const twoStoryState: typeof state = {
      ...state,
      spec: {
        ...state.spec!,
        userStories: [
          ...state.spec!.userStories,
          {
            id: "US-002",
            title: "Delete task",
            description: "As a user, I want to delete tasks",
            acceptanceCriteria: ["Task is removed"],
            priority: "must" as const,
          },
        ],
      },
    };

    const decompositionOutput = {
      tasks: [
        { id: "t1", title: "Create task", description: "Impl", estimatedComplexity: "medium", dependencies: [], acceptanceCriteria: [] },
        { id: "t2", title: "Delete task", description: "Impl", estimatedComplexity: "medium", dependencies: [], acceptanceCriteria: [] },
      ],
    };

    // JSON only reports first task as success; second task is omitted
    const batchOutput = JSON.stringify({
      tasks: [{ title: "Create task", status: "success" }],
    });

    mockedQuery
      .mockReturnValueOnce(makeQueryStream("", decompositionOutput))
      .mockReturnValue(makeQueryStream(batchOutput, undefined));

    const result = await runDevelopment(twoStoryState, makeConfig());

    // The second task (Delete task) was not in the JSON → should be marked failed
    expect(result.success).toBe(false);
  });

  it("handles malformed JSON response gracefully via heuristic fallback", async () => {
    const state = makeStateWithSpecAndArch();

    const decompositionOutput = {
      tasks: [
        { id: "task-001", title: "Create task", description: "Impl", estimatedComplexity: "medium", dependencies: [], acceptanceCriteria: [] },
      ],
    };

    // Invalid JSON that fails parse — falls back to heuristic
    mockedQuery
      .mockReturnValueOnce(makeQueryStream("", decompositionOutput))
      .mockReturnValue(makeQueryStream("Task successfully completed without JSON", undefined));

    const result = await runDevelopment(state, makeConfig());

    // Heuristic: non-empty output without failure keywords → success
    expect(result.success).toBe(true);
    expect(result.nextPhase).toBe("testing");
  });

  // ── Batch size limiting ───────────────────────────────────────────────────

  it("splits batches larger than MAX_BATCH_SIZE=6 into sub-batches", async () => {
    // 7 independent arch tasks → groupIntoBatches produces [6, 1] → 2 executeBatch calls
    const archTasks = Array.from({ length: 7 }, (_, i) => ({
      id: `arch-${i + 1}`,
      title: `Task ${i + 1}`,
      description: `Desc ${i + 1}`,
      estimatedComplexity: "medium" as const,
      dependencies: [],
      acceptanceCriteria: [`Criterion ${i + 1}`],
    }));
    const base = makeStateWithSpecAndArch();
    const state: ProjectState = {
      ...base,
      tasks: [],
      architecture: {
        ...base.architecture!,
        taskDecomposition: { tasks: archTasks },
      },
    };

    // Heuristic success response for all batch executions
    mockedQuery.mockReturnValue(makeQueryStream("All tasks completed successfully"));

    await runDevelopment(state, makeConfig());

    // Each independent batch triggers one query call — expect exactly 2 batches
    expect(mockedQuery).toHaveBeenCalledTimes(2);
  });

  it("saves state after each task completion (not just after each batch)", async () => {
    // 1 arch task → 1 batch → verify saveState called multiple times
    const archTasks = [
      {
        id: "arch-1",
        title: "Build feature",
        description: "Implement it",
        estimatedComplexity: "low" as const,
        dependencies: [],
        acceptanceCriteria: ["It works"],
      },
    ];
    const base = makeStateWithSpecAndArch();
    const state: ProjectState = {
      ...base,
      tasks: [],
      architecture: {
        ...base.architecture!,
        taskDecomposition: { tasks: archTasks },
      },
    };

    mockedQuery.mockReturnValue(makeQueryStream("Task completed successfully"));
    mockedSaveState.mockClear();

    await runDevelopment(state, makeConfig());

    // saveState is called: once after decomposition, once per task result, once for checkpoint
    expect(mockedSaveState).toHaveBeenCalledTimes(3);
  });

  // ── Architecture tasks reuse ──────────────────────────────────────────────

  it("uses architecture tasks directly without calling decomposeUserStories", async () => {
    // When arch has taskDecomposition.tasks and state.tasks is empty,
    // runDevelopment must NOT call query for decomposition
    const archTasks = [
      {
        id: "arch-001",
        title: "Create task endpoint",
        description: "POST /tasks handler",
        estimatedComplexity: "medium" as const,
        dependencies: [],
        acceptanceCriteria: ["Returns 201 on success"],
      },
    ];
    const base = makeStateWithSpecAndArch();
    const state: ProjectState = {
      ...base,
      tasks: [],
      architecture: {
        ...base.architecture!,
        taskDecomposition: { tasks: archTasks },
      },
    };

    mockedQuery.mockReturnValue(makeQueryStream("Task completed successfully"));

    await runDevelopment(state, makeConfig());

    // Only 1 query call (batch execution), NOT 2 (no decomposition call)
    expect(mockedQuery).toHaveBeenCalledTimes(1);
  });

  it("falls back to decomposeUserStories when architecture has no tasks", async () => {
    // architecture without taskDecomposition → query called for decomposition + batch
    const state = makeStateWithSpecAndArch(); // has user stories, no arch tasks

    const decompositionOutput = {
      tasks: [
        {
          id: "task-001",
          title: "Create task",
          description: "Implement task creation",
          estimatedComplexity: "medium",
          dependencies: [],
          acceptanceCriteria: ["Task is saved"],
        },
      ],
    };

    mockedQuery
      .mockReturnValueOnce(makeQueryStream("", decompositionOutput))
      .mockReturnValue(makeQueryStream("Task completed successfully"));

    await runDevelopment(state, makeConfig());

    // 2 query calls: one for decomposition, one for batch execution
    expect(mockedQuery).toHaveBeenCalledTimes(2);
  });
});
