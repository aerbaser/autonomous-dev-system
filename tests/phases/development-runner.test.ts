import { describe, it, expect, vi, beforeEach } from "vitest";
import { createInitialState } from "../../src/state/project-state.js";
import type { ProjectState } from "../../src/state/project-state.js";
import type { Config } from "../../src/utils/config.js";
import {
  parseTaskResults,
  harvestReceipts,
  persistReceipt,
  extractAllJsonObjects,
  matchDomainAgentForTask,
} from "../../src/phases/development-runner.js";
import type { AgentBlueprint } from "../../src/state/project-state.js";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  it("freeform text output NEVER counts as success (Phase 6: no heuristic)", async () => {
    const state = makeStateWithSpecAndArch();

    const decompositionOutput = {
      tasks: [
        { id: "task-001", title: "Create task", description: "Impl", estimatedComplexity: "medium", dependencies: [], acceptanceCriteria: [] },
      ],
    };

    // Freeform text without a valid TaskReceipt — under Phase 6 this MUST be
    // treated as failed (invalid_structured_output), never as success.
    mockedQuery
      .mockReturnValueOnce(makeQueryStream("", decompositionOutput))
      .mockReturnValue(makeQueryStream("Task successfully completed without JSON", undefined));

    const result = await runDevelopment(state, makeConfig());

    expect(result.success).toBe(false);
    const failed = result.state.tasks.filter((t) => t.status === "failed");
    expect(failed.length).toBeGreaterThan(0);
    // Error must reference the structured-receipt rejection
    expect(failed[0]!.error).toMatch(/structured receipt|invalid_structured_output/);
  });

  // ── Batch size limiting ───────────────────────────────────────────────────

  it("splits batches larger than MAX_BATCH_SIZE=6 into sub-batches", async () => {
    // 7 independent arch tasks → groupIntoBatches produces [6, 1].
    // Phase 3: direct-dispatch fast path runs each task's subagent in its
    // own query() call (no lead wrapper), so 6 + 1 = 7 query invocations.
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

    // Direct-dispatch: one query() per task — 7 tasks split into [6, 1]
    // batches = 7 total calls.
    expect(mockedQuery).toHaveBeenCalledTimes(7);
  });

  it("legacy lead-developer coordinator wraps the batch in ONE query call when enabled", async () => {
    // Opt-in debug path: developmentCoordinator.enabled === true re-enables
    // the legacy lead wrapper, which bundles the whole batch into a single
    // query() call with Agent-tool delegation.
    const archTasks = Array.from({ length: 3 }, (_, i) => ({
      id: `arch-${i + 1}`,
      title: `Task ${i + 1}`,
      description: `Desc ${i + 1}`,
      estimatedComplexity: "medium" as const,
      dependencies: [],
      acceptanceCriteria: [],
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

    mockedQuery.mockReturnValue(makeQueryStream("Lead wrapper output"));

    const config = makeConfig();
    config.developmentCoordinator = { enabled: true };

    await runDevelopment(state, config);

    // Legacy path: one query() for the whole batch, not one per task.
    expect(mockedQuery).toHaveBeenCalledTimes(1);
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

  // ── Parallel batch scheduling (removed — see "prefer ours" in merge plan) ──
  // The merged branch keeps the sequential-batch flow with TaskReceipt parsing
  // (Phase 6). Tests that probed main's parallel scheduler (`estimateTaskFileGlobs`,
  // `batchesConflict`, `buildBatchAgents`, `buildSharedTaskContext`, etc.) have
  // been removed; their assertions targeted functions that no longer exist in
  // this branch's development-runner.

  // (deleted: parallel-scheduler-specific test cases — see comment above.)

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

  // (deleted: token-waste / prompt-cache tests — targeted main's
  // `buildBatchAgents` / `buildSharedTaskContext` / `buildTaskPrompt` helpers
  // which are not exported from this branch's development-runner.)
});

// ── parseTaskResults / harvestReceipts / persistReceipt (Phase 6) ──────────

function baseReceipt(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "task-001",
    taskTitle: "Create task",
    teamMemberId: "dev-alpha",
    agentRole: "developer",
    model: "claude-sonnet-4-6",
    sessionIds: ["s1"],
    changedFiles: ["src/foo.ts"],
    verificationCommands: [
      { command: "npx tsc --noEmit", success: true, exitCode: 0 },
    ],
    status: "success",
    startedAt: "2026-04-17T10:00:00.000Z",
    completedAt: "2026-04-17T10:05:00.000Z",
    ...overrides,
  };
}

function makeTaskStub(id: string, title: string): Task {
  return {
    id,
    title,
    description: "",
    status: "pending",
    createdAt: new Date().toISOString(),
  } as Task;
}

describe("extractAllJsonObjects", () => {
  it("extracts multiple balanced JSON objects", () => {
    const text = `prefix ${JSON.stringify({ a: 1 })} middle ${JSON.stringify({
      b: 2,
    })} suffix`;
    const found = extractAllJsonObjects(text);
    expect(found.length).toBe(2);
    expect(JSON.parse(found[0]!)).toEqual({ a: 1 });
    expect(JSON.parse(found[1]!)).toEqual({ b: 2 });
  });

  it("ignores braces inside strings", () => {
    const text = `note: "{not json}" ${JSON.stringify({ ok: true })}`;
    const found = extractAllJsonObjects(text);
    expect(found.length).toBe(1);
    expect(JSON.parse(found[0]!)).toEqual({ ok: true });
  });

  it("returns [] when no JSON object present", () => {
    expect(extractAllJsonObjects("plain text only")).toEqual([]);
  });
});

describe("harvestReceipts", () => {
  it("harvests a valid single receipt", () => {
    const out = `\n\`\`\`json\n${JSON.stringify(baseReceipt())}\n\`\`\``;
    const receipts = harvestReceipts(out);
    expect(receipts.length).toBe(1);
    expect(receipts[0]!.taskId).toBe("task-001");
  });

  it("harvests receipts from an envelope", () => {
    const envelope = {
      receipts: [
        baseReceipt(),
        baseReceipt({ taskId: "task-002", taskTitle: "Another" }),
      ],
    };
    const out = `Summary\n${JSON.stringify(envelope)}\nEnd.`;
    const receipts = harvestReceipts(out);
    expect(receipts.length).toBe(2);
  });

  it("drops malformed receipts", () => {
    const bad = { ...baseReceipt(), status: "unknown-value" };
    const out = JSON.stringify(bad);
    expect(harvestReceipts(out)).toEqual([]);
  });

  it("dedupes receipts by taskId", () => {
    const out = `${JSON.stringify(baseReceipt())} ${JSON.stringify(
      baseReceipt(),
    )}`;
    expect(harvestReceipts(out).length).toBe(1);
  });

  it("returns [] for freeform text", () => {
    expect(harvestReceipts("Task done. All good!")).toEqual([]);
  });
});

describe("parseTaskResults (Phase 6 — receipt-based)", () => {
  it("freeform text → status failed, no success (no heuristic)", () => {
    const tasks = [makeTaskStub("task-001", "Create task")];
    const results = parseTaskResults("All tasks completed successfully!", tasks);
    expect(results.length).toBe(1);
    expect(results[0]!.success).toBe(false);
    expect(results[0]!.receipt?.status).toBe("failed");
    expect(results[0]!.receipt?.failureReasonCode).toBe(
      "invalid_structured_output",
    );
  });

  it("valid success receipt → TaskResult.success = true", () => {
    const tasks = [makeTaskStub("task-001", "Create task")];
    const out = JSON.stringify(baseReceipt());
    const results = parseTaskResults(out, tasks);
    expect(results[0]!.success).toBe(true);
    expect(results[0]!.receipt?.status).toBe("success");
  });

  it("blocked receipt → TaskResult.success = false", () => {
    const tasks = [makeTaskStub("task-001", "Create task")];
    const out = JSON.stringify(
      baseReceipt({ status: "blocked", failureReasonCode: "blocked_filesystem" }),
    );
    const results = parseTaskResults(out, tasks);
    expect(results[0]!.success).toBe(false);
    expect(results[0]!.receipt?.status).toBe("blocked");
  });

  it("partial receipt → TaskResult.success = false", () => {
    const tasks = [makeTaskStub("task-001", "Create task")];
    const out = JSON.stringify(baseReceipt({ status: "partial" }));
    const results = parseTaskResults(out, tasks);
    expect(results[0]!.success).toBe(false);
    expect(results[0]!.receipt?.status).toBe("partial");
  });

  it("missing required field in receipt → invalid_structured_output", () => {
    const tasks = [makeTaskStub("task-001", "Create task")];
    const { teamMemberId: _tm, ...broken } = baseReceipt();
    void _tm;
    const out = JSON.stringify(broken);
    const results = parseTaskResults(out, tasks);
    expect(results[0]!.success).toBe(false);
    expect(results[0]!.receipt?.failureReasonCode).toBe(
      "invalid_structured_output",
    );
  });

  it("falls back to title match when taskId does not match", () => {
    const tasks = [makeTaskStub("orig-id", "Create task")];
    // Receipt taskId doesn't match the project task.id, but title does
    const out = JSON.stringify(baseReceipt({ taskId: "mismatched" }));
    const results = parseTaskResults(out, tasks);
    expect(results[0]!.success).toBe(true);
  });

  it("one success + one missing receipt in the same output → only first is success", () => {
    const tasks = [
      makeTaskStub("task-001", "Create task"),
      makeTaskStub("task-002", "Delete task"),
    ];
    const out = JSON.stringify(baseReceipt());
    const results = parseTaskResults(out, tasks);
    expect(results[0]!.success).toBe(true);
    expect(results[1]!.success).toBe(false);
    expect(results[1]!.receipt?.failureReasonCode).toBe(
      "invalid_structured_output",
    );
  });

  it("envelope with both success and blocked receipts is parsed correctly", () => {
    const tasks = [
      makeTaskStub("task-001", "Create task"),
      makeTaskStub("task-002", "Delete task"),
    ];
    const envelope = {
      receipts: [
        baseReceipt(),
        baseReceipt({
          taskId: "task-002",
          taskTitle: "Delete task",
          status: "blocked",
          failureReasonCode: "permission_denied",
        }),
      ],
    };
    const out = JSON.stringify(envelope);
    const results = parseTaskResults(out, tasks);
    expect(results[0]!.success).toBe(true);
    expect(results[1]!.success).toBe(false);
    expect(results[1]!.receipt?.status).toBe("blocked");
  });
});

describe("persistReceipt", () => {
  it("writes receipt JSON to <stateDir>/receipts/<phaseId>/<taskId>.json", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ads-receipts-"));
    const receipt = baseReceipt();
    const path = persistReceipt(tmp, "development", receipt as any);
    expect(path).not.toBeNull();
    expect(existsSync(path!)).toBe(true);
    const written = JSON.parse(readFileSync(path!, "utf8"));
    expect(written.taskId).toBe("task-001");
    expect(written.status).toBe("success");
  });
});

describe("runDevelopment — blocked task never persists as completed", () => {
  it("blocked receipt marks state.tasks[].status = 'failed', not 'completed'", async () => {
    const archTasks = [
      {
        id: "arch-block",
        title: "Risky change",
        description: "touch src/x.ts",
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

    const receipt = baseReceipt({
      taskId: "arch-block",
      taskTitle: "Risky change",
      status: "blocked",
      failureReasonCode: "blocked_filesystem",
    });
    mockedQuery.mockReturnValue(makeQueryStream(JSON.stringify(receipt)));

    const result = await runDevelopment(state, makeConfig());

    expect(result.success).toBe(false);
    const tasks = result.state.tasks;
    const blocked = tasks.find((t) => t.title === "Risky change");
    expect(blocked).toBeDefined();
    expect(blocked!.status).toBe("failed");
    expect(blocked!.status).not.toBe("completed");
  });
});

describe("matchDomainAgentForTask (HIGH-06)", () => {
  function makeAgent(overrides: Partial<AgentBlueprint>): AgentBlueprint {
    return {
      name: "default",
      role: "generic",
      systemPrompt: "",
      tools: [],
      evaluationCriteria: [],
      version: 1,
      ...overrides,
    } as AgentBlueprint;
  }

  function makeTask(overrides: Partial<{ id: string; title: string; description: string; status: "pending" | "in_progress" | "completed" | "failed"; tags: string[] }>) {
    return {
      id: "t1",
      title: "Task",
      description: "",
      status: "pending" as const,
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it("selects the domain agent whose keywords appear in the task description", () => {
    const billing = makeAgent({ name: "BillingAgent", role: "payments", keywords: ["stripe", "invoice", "checkout"] });
    const auth = makeAgent({ name: "AuthAgent", role: "security", keywords: ["oauth", "jwt", "session"] });
    const task = makeTask({ title: "Implement Stripe checkout flow", description: "Use stripe SDK to process invoice payments" });

    const picked = matchDomainAgentForTask(task, [billing, auth]);
    expect(picked?.name).toBe("BillingAgent");
  });

  it("returns undefined when no keywords match (caller must fall back to default)", () => {
    const billing = makeAgent({ name: "BillingAgent", role: "payments", keywords: ["stripe", "invoice"] });
    const task = makeTask({ title: "Refactor logger", description: "Move from console to pino" });

    expect(matchDomainAgentForTask(task, [billing])).toBeUndefined();
  });

  it("scores tag matches and picks the higher-scoring agent", () => {
    const data = makeAgent({ name: "DataAgent", role: "data", keywords: ["etl", "pipeline"] });
    const ui = makeAgent({ name: "UiAgent", role: "frontend", keywords: ["form", "modal", "button"] });
    const task = makeTask({ title: "Add subscription form", description: "New modal with email field", tags: ["form", "modal"] });

    const picked = matchDomainAgentForTask(task, [data, ui]);
    expect(picked?.name).toBe("UiAgent");
  });

  it("breaks ties in input order (first matching agent wins)", () => {
    const a = makeAgent({ name: "AgentA", role: "x", keywords: ["alpha"] });
    const b = makeAgent({ name: "AgentB", role: "y", keywords: ["alpha"] });
    const task = makeTask({ title: "handle alpha case", description: "" });

    expect(matchDomainAgentForTask(task, [a, b])?.name).toBe("AgentA");
  });

  it("matches by agent name and role (not just keywords)", () => {
    const agent = makeAgent({ name: "PaymentsAgent", role: "billing" });
    const task = makeTask({ title: "PaymentsAgent refactor for new SKU", description: "" });

    expect(matchDomainAgentForTask(task, [agent])?.name).toBe("PaymentsAgent");
  });
});
