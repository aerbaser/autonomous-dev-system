import { describe, it, expect, vi, beforeEach } from "vitest";
import { createInitialState } from "../../src/state/project-state.js";
import type { ProjectState } from "../../src/state/project-state.js";
import type { Config } from "../../src/utils/config.js";
import {
  estimateTaskFileGlobs,
  batchesConflict,
  buildBatchAgents,
  buildTaskPrompt,
  buildSharedTaskContext,
} from "../../src/phases/development-runner.js";
import type { Task } from "../../src/state/project-state.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

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

  // ── Parallel batch scheduling ─────────────────────────────────────────────

  function makeTask(id: string, title: string, description: string): Task {
    return {
      id,
      title,
      description,
      status: "pending",
      createdAt: new Date().toISOString(),
    } as Task;
  }

  it("estimateTaskFileGlobs extracts paths from descriptions", () => {
    // Explicit path with extension
    const t1 = { title: "Fix bug", description: "Edit src/foo/bar.ts to add validation" };
    expect(estimateTaskFileGlobs(t1)).toContain("src/foo/bar.ts");

    // Filename alone with extension
    const t2 = { title: "Update config", description: "Modify config.json defaults" };
    expect(estimateTaskFileGlobs(t2)).toContain("config.json");

    // Component name after verb
    const t3 = { title: "Create UserProfile", description: "Build the page" };
    const g3 = estimateTaskFileGlobs(t3);
    expect(g3.some((g) => g.startsWith("component:"))).toBe(true);

    // Empty / non-descriptive → fallback to ["*"]
    const t4 = { title: "do things", description: "stuff" };
    expect(estimateTaskFileGlobs(t4)).toEqual(["*"]);
  });

  it("batchesConflict: disjoint paths do not conflict", () => {
    const a = [makeTask("a1", "Edit src/a.ts", "change src/a.ts")];
    const b = [makeTask("b1", "Edit src/b.ts", "change src/b.ts")];
    expect(batchesConflict(a, b)).toBe(false);
  });

  it("batchesConflict: shared paths conflict", () => {
    const a = [makeTask("a1", "Update shared.ts", "edit src/shared.ts")];
    const b = [makeTask("b1", "Fix shared.ts", "also edit src/shared.ts")];
    expect(batchesConflict(a, b)).toBe(true);
  });

  it("batchesConflict: empty-glob fallback (*) conflicts with anything", () => {
    const a = [makeTask("a1", "do stuff", "vague")];
    const b = [makeTask("b1", "Edit src/b.ts", "change src/b.ts")];
    expect(batchesConflict(a, b)).toBe(true);
  });

  it("parallel batches: disjoint file globs run concurrently", async () => {
    // Build two independent arch tasks touching different files
    const archTasks = [
      {
        id: "arch-1",
        title: "Edit src/alpha.ts",
        description: "Modify src/alpha.ts logic",
        estimatedComplexity: "low" as const,
        dependencies: [],
        acceptanceCriteria: ["done"],
      },
      {
        id: "arch-2",
        title: "Edit src/beta.ts",
        description: "Modify src/beta.ts logic",
        estimatedComplexity: "low" as const,
        dependencies: [],
        acceptanceCriteria: ["done"],
      },
    ];
    const base = makeStateWithSpecAndArch();
    const state: ProjectState = {
      ...base,
      tasks: [],
      architecture: { ...base.architecture!, taskDecomposition: { tasks: archTasks } },
    };

    // groupIntoBatches keeps independent tasks in ONE batch, so force two
    // batches by adding a fake dependency: rewrite to make them separate.
    // Simpler: split into 7 disjoint tasks so MAX_BATCH_SIZE=6 forces split.
    const manyTasks = Array.from({ length: 7 }, (_, i) => ({
      id: `arch-m${i}`,
      title: `Edit src/file${i}.ts`,
      description: `Modify src/file${i}.ts isolated`,
      estimatedComplexity: "low" as const,
      dependencies: [],
      acceptanceCriteria: ["done"],
    }));
    state.architecture!.taskDecomposition = { tasks: manyTasks };

    const startTimes: number[] = [];
    mockedQuery.mockImplementation(() => {
      startTimes.push(Date.now());
      // Synthetic stream that completes after 40ms
      return {
        [Symbol.asyncIterator]() {
          let done = false;
          return {
            async next() {
              if (done) return { value: undefined, done: true as const };
              await new Promise((r) => setTimeout(r, 40));
              done = true;
              return {
                value: {
                  type: "result",
                  subtype: "success",
                  result: "All tasks completed",
                  session_id: "s",
                  total_cost_usd: 0,
                  num_turns: 1,
                },
                done: false as const,
              };
            },
          };
        },
        close() {},
      } as any;
    });

    await runDevelopment(state, makeConfig());

    // With 7 disjoint tasks split into 2 batches (6 + 1), and
    // maxParallelBatches=3 default, they must start near-simultaneously.
    expect(startTimes.length).toBe(2);
    expect(Math.abs(startTimes[1]! - startTimes[0]!)).toBeLessThan(25);
  });

  it("parallel batches: overlapping globs stay serial", async () => {
    // 7 tasks all referencing the SAME file — MAX_BATCH_SIZE=6 splits them
    // into [6, 1] and they share "src/shared.ts", so they conflict and the
    // second batch must wait.
    const manyTasks = Array.from({ length: 7 }, (_, i) => ({
      id: `arch-s${i}`,
      title: `Update src/shared.ts task ${i}`,
      description: `Edit src/shared.ts for step ${i}`,
      estimatedComplexity: "low" as const,
      dependencies: [],
      acceptanceCriteria: ["done"],
    }));
    const base = makeStateWithSpecAndArch();
    const state: ProjectState = {
      ...base,
      tasks: [],
      architecture: {
        ...base.architecture!,
        taskDecomposition: { tasks: manyTasks },
      },
    };

    const startTimes: number[] = [];
    const endTimes: number[] = [];
    mockedQuery.mockImplementation(() => {
      startTimes.push(Date.now());
      return {
        [Symbol.asyncIterator]() {
          let done = false;
          return {
            async next() {
              if (done) return { value: undefined, done: true as const };
              await new Promise((r) => setTimeout(r, 50));
              done = true;
              endTimes.push(Date.now());
              return {
                value: {
                  type: "result",
                  subtype: "success",
                  result: "done",
                  session_id: "s",
                  total_cost_usd: 0,
                  num_turns: 1,
                },
                done: false as const,
              };
            },
          };
        },
        close() {},
      } as any;
    });

    await runDevelopment(state, makeConfig());

    expect(startTimes.length).toBe(2);
    // Second batch starts only after the first batch's query has ended.
    expect(startTimes[1]!).toBeGreaterThanOrEqual(endTimes[0]! - 2);
  });

  it("respects maxParallelBatches cap", async () => {
    // 5 disjoint batches, maxParallelBatches=2 → at most 2 in flight at a time.
    // Force each task to become its own batch by chaining dependencies such
    // that only independent groups form. Simpler: 5 groups of 7 disjoint
    // tasks each is overkill; we rely on MAX_BATCH_SIZE=6 and construct 5
    // separate independent batches via a dependency chain that yields one
    // batch per "level".
    const manyTasks = [
      // Level 0: one task
      { id: "L0", title: "Edit src/a0.ts", description: "src/a0.ts",
        estimatedComplexity: "low" as const, dependencies: [], acceptanceCriteria: ["ok"] },
      // Level 1: one task depends on L0
      { id: "L1", title: "Edit src/a1.ts", description: "src/a1.ts",
        estimatedComplexity: "low" as const, dependencies: ["L0"], acceptanceCriteria: ["ok"] },
      // Level 2: depends on L1
      { id: "L2", title: "Edit src/a2.ts", description: "src/a2.ts",
        estimatedComplexity: "low" as const, dependencies: ["L1"], acceptanceCriteria: ["ok"] },
      // Level 3: depends on L2
      { id: "L3", title: "Edit src/a3.ts", description: "src/a3.ts",
        estimatedComplexity: "low" as const, dependencies: ["L2"], acceptanceCriteria: ["ok"] },
      // Level 4: depends on L3
      { id: "L4", title: "Edit src/a4.ts", description: "src/a4.ts",
        estimatedComplexity: "low" as const, dependencies: ["L3"], acceptanceCriteria: ["ok"] },
    ];
    // Depended-on chain: only serial — not useful for concurrency test.
    // Instead: Build one big independent batch of 13 tasks → splits into
    // [6, 6, 1] = 3 batches. Each disjoint. With cap=2, at most 2 in-flight.
    const independentTasks = Array.from({ length: 13 }, (_, i) => ({
      id: `I${i}`,
      title: `Edit src/dir${i}/file.ts`,
      description: `Edit src/dir${i}/file.ts`,
      estimatedComplexity: "low" as const,
      dependencies: [],
      acceptanceCriteria: ["ok"],
    }));
    void manyTasks; // unused, kept for clarity

    const base = makeStateWithSpecAndArch();
    const state: ProjectState = {
      ...base,
      tasks: [],
      architecture: {
        ...base.architecture!,
        taskDecomposition: { tasks: independentTasks },
      },
    };

    let inFlight = 0;
    let maxInFlight = 0;
    mockedQuery.mockImplementation(() => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      return {
        [Symbol.asyncIterator]() {
          let done = false;
          return {
            async next() {
              if (done) return { value: undefined, done: true as const };
              await new Promise((r) => setTimeout(r, 30));
              done = true;
              inFlight--;
              return {
                value: {
                  type: "result",
                  subtype: "success",
                  result: "done",
                  session_id: "s",
                  total_cost_usd: 0,
                  num_turns: 1,
                },
                done: false as const,
              };
            },
          };
        },
        close() {},
      } as any;
    });

    const cfg = { ...makeConfig(), maxParallelBatches: 2 } as Config;
    await runDevelopment(state, cfg);

    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThanOrEqual(2); // proves concurrency did kick in
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

  // ── Token-waste / prompt-cache refactor (Stream 1) ────────────────────────

  function makeBatch(n: number): Task[] {
    return Array.from({ length: n }, (_, i) => makeTask(
      `task-${i}`,
      `Implement feature ${i}`,
      `Build src/feature${i}.ts with all the logic`,
    ));
  }

  function freshRegistry(): AgentRegistry {
    const dir = mkdtempSync(join(tmpdir(), "ads-dev-runner-"));
    return new AgentRegistry(dir);
  }

  it("buildBatchAgents: architecture JSON appears AT MOST ONCE per agent, not duplicated as a distinct stringification", () => {
    const state = makeStateWithSpecAndArch();
    const batch = makeBatch(3);
    const registry = freshRegistry();
    const agents = buildBatchAgents(batch, state, {}, makeConfig(), registry);

    // Every task-agent's prompt carries the architecture block exactly once,
    // via the single shared cached context. That's the cache-friendly shape:
    // identical prefixes → SDK can cache-match.
    const archJson = JSON.stringify(state.architecture, null, 2);
    for (const [, def] of Object.entries(agents)) {
      const occurrences = def.prompt!.split(archJson).length - 1;
      expect(occurrences).toBeLessThanOrEqual(1);
    }
  });

  it("buildBatchAgents: all task agents share the EXACT same architecture prefix (cache-friendly)", () => {
    const state = makeStateWithSpecAndArch();
    const batch = makeBatch(3);
    const registry = freshRegistry();
    const agents = buildBatchAgents(batch, state, {}, makeConfig(), registry);

    const taskAgents = Object.entries(agents).filter(([name]) =>
      name.startsWith("dev-")
    );
    expect(taskAgents.length).toBe(3);

    // The shared cached context must appear verbatim inside every task agent
    // prompt — that's what makes the Anthropic ephemeral cache hit.
    const sharedContext = buildSharedTaskContext(state);
    for (const [, def] of taskAgents) {
      expect(def.prompt!).toContain(sharedContext);
    }
  });

  it("buildTaskPrompt: no longer embeds architecture JSON directly", () => {
    const state = makeStateWithSpecAndArch();
    const task = makeTask("t1", "Do thing", "Implement src/x.ts");
    const sharedContext = buildSharedTaskContext(state);
    const prompt = buildTaskPrompt(task, sharedContext);

    // Architecture JSON only appears because sharedContext carries it —
    // it is not re-stringified inside buildTaskPrompt itself.
    const withoutShared = prompt.replace(sharedContext, "");
    const archJson = JSON.stringify(state.architecture, null, 2);
    expect(withoutShared).not.toContain(archJson);

    // And the per-task content must be present.
    expect(prompt).toContain(task.title);
    expect(prompt).toContain(task.description);
  });

  it("single-task batch bypasses Agent tool (no delegation wrapper)", async () => {
    const archTasks = [
      {
        id: "arch-solo",
        title: "Single task",
        description: "Implement src/solo.ts",
        estimatedComplexity: "low" as const,
        dependencies: [],
        acceptanceCriteria: ["done"],
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

    mockedQuery.mockReturnValue(
      makeQueryStream(
        JSON.stringify({ tasks: [{ title: "Single task", status: "success" }] })
      )
    );

    await runDevelopment(state, makeConfig());

    // There should be exactly one query call (the single task, dispatched
    // directly as its subagent rather than through a lead-agent wrapper).
    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const callArg = mockedQuery.mock.calls[0]![0] as {
      options: { allowedTools?: string[] };
    };
    // Agent tool MUST NOT be on the allowedTools list for the single-task path.
    expect(callArg.options.allowedTools).toBeDefined();
    expect(callArg.options.allowedTools!).not.toContain("Agent");
  });

  it("multi-task batch still exposes Agent tool to the lead agent", async () => {
    // 2 independent tasks referencing different files → one batch of 2.
    const archTasks = [
      {
        id: "arch-a",
        title: "Edit src/a.ts",
        description: "Implement src/a.ts",
        estimatedComplexity: "low" as const,
        dependencies: [],
        acceptanceCriteria: ["done"],
      },
      {
        id: "arch-b",
        title: "Edit src/b.ts",
        description: "Implement src/b.ts",
        estimatedComplexity: "low" as const,
        dependencies: [],
        acceptanceCriteria: ["done"],
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

    mockedQuery.mockReturnValue(
      makeQueryStream(
        JSON.stringify({
          tasks: [
            { title: "Edit src/a.ts", status: "success" },
            { title: "Edit src/b.ts", status: "success" },
          ],
        })
      )
    );

    await runDevelopment(state, makeConfig());

    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const callArg = mockedQuery.mock.calls[0]![0] as {
      options: { allowedTools?: string[] };
    };
    expect(callArg.options.allowedTools).toContain("Agent");
  });
});
