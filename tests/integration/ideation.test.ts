import { describe, it, expect, vi, beforeEach } from "vitest";
import { createInitialState } from "../../src/state/project-state.js";
import type { Config } from "../../src/utils/config.js";

// Mock the Agent SDK
vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  return {
    query: vi.fn(),
  };
});

// Mock domain analyzer to avoid real SDK calls
vi.mock("../../src/agents/domain-analyzer.js", () => ({
  analyzeDomain: vi.fn(),
}));

const { query } = await import("@anthropic-ai/claude-agent-sdk");
const { analyzeDomain } = await import("../../src/agents/domain-analyzer.js");
const { runIdeation } = await import("../../src/phases/ideation.js");

const mockedQuery = vi.mocked(query);
const mockedAnalyzeDomain = vi.mocked(analyzeDomain);

function makeConfig(): Config {
  return {
    model: "claude-sonnet-4-6",
    subagentModel: "claude-sonnet-4-6",
    selfImprove: { enabled: false, maxIterations: 50, nightlyOptimize: false },
    projectDir: ".",
    stateDir: ".autonomous-dev",
    memory: { enabled: false, maxDocuments: 500, maxDocumentSizeKb: 100 },
    rubrics: { enabled: false, maxIterations: 3 },
  };
}

function makeMockQueryIterator(resultText: string) {
  return {
    [Symbol.asyncIterator]() {
      let done = false;
      return {
        async next() {
          if (done) return { value: undefined, done: true };
          done = true;
          return {
            value: {
              result: resultText,
              type: "result",
              subtype: "success",
              session_id: "test-s",
              total_cost_usd: 0.01,
              num_turns: 1,
            },
            done: false,
          };
        },
      };
    },
    close() {},
  };
}

describe("Ideation Phase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("generates a valid product spec from query result", async () => {
    const specJson = JSON.stringify({
      summary: "A task management app for teams with real-time collaboration",
      userStories: [
        {
          id: "US-001",
          title: "Create task",
          description: "As a user, I want to create tasks so I can track work",
          acceptanceCriteria: [
            "Given the dashboard, When I click 'New Task', Then a task form appears",
            "Given a task form, When I fill details and submit, Then the task is created",
          ],
          priority: "must",
        },
        {
          id: "US-002",
          title: "Assign task",
          description: "As a team lead, I want to assign tasks to team members",
          acceptanceCriteria: [
            "Given a task, When I select an assignee, Then the task shows the assignee",
          ],
          priority: "must",
        },
        {
          id: "US-003",
          title: "Filter tasks",
          description: "As a user, I want to filter tasks by status",
          acceptanceCriteria: [
            "Given the task list, When I select a status filter, Then only matching tasks show",
          ],
          priority: "should",
        },
        {
          id: "US-004",
          title: "Real-time updates",
          description: "As a team member, I want to see changes in real time",
          acceptanceCriteria: [
            "Given a shared board, When another user updates a task, Then I see it immediately",
          ],
          priority: "should",
        },
        {
          id: "US-005",
          title: "Notifications",
          description: "As a user, I want notifications when assigned a task",
          acceptanceCriteria: [
            "Given a task assignment, When I am assigned, Then I receive a notification",
          ],
          priority: "could",
        },
      ],
      nonFunctionalRequirements: [
        "Performance: page load under 2s",
        "Security: OWASP top 10 compliance",
        "Availability: 99.9% uptime",
      ],
    });

    // Mock query to return a realistic spec
    mockedQuery.mockReturnValue(makeMockQueryIterator(specJson) as any);

    // Mock domain analysis
    mockedAnalyzeDomain.mockResolvedValue({
      classification: "productivity",
      specializations: ["real-time collaboration"],
      requiredRoles: [],
      requiredMcpServers: ["playwright"],
      techStack: ["typescript", "react", "websockets"],
    });

    const state = createInitialState("Build a team task management app");
    const result = await runIdeation(state, makeConfig());

    expect(result.success).toBe(true);
    expect(result.nextPhase).toBe("specification");
    expect(result.state.spec).toBeDefined();
    expect(result.state.spec!.userStories.length).toBeGreaterThanOrEqual(5);
    expect(result.state.spec!.nonFunctionalRequirements.length).toBeGreaterThanOrEqual(3);
    expect(result.state.spec!.domain.classification).toBe("productivity");

    // Verify every user story has acceptance criteria
    for (const story of result.state.spec!.userStories) {
      expect(story.acceptanceCriteria.length).toBeGreaterThan(0);
      expect(story.id).toBeTruthy();
      expect(story.title).toBeTruthy();
    }

    // Verify MoSCoW priorities
    const priorities = result.state.spec!.userStories.map((s) => s.priority);
    expect(priorities.filter((p) => p === "must").length).toBeGreaterThanOrEqual(2);
  });

  it("repairs a non-JSON spec response into valid JSON", async () => {
    const repairedSpecJson = JSON.stringify({
      summary: "A focused todo app for small teams",
      userStories: [
        {
          id: "US-001",
          title: "Create task",
          description: "As a user, I want to create tasks so I can track work",
          acceptanceCriteria: [
            "Given the dashboard, When I click new task, Then a task form appears",
          ],
          priority: "must",
        },
      ],
      nonFunctionalRequirements: [
        "Performance: page load under 2s",
      ],
    });

    mockedQuery
      .mockReturnValueOnce(makeMockQueryIterator("I could not generate a spec for this idea.") as any)
      .mockReturnValueOnce(makeMockQueryIterator(repairedSpecJson) as any);

    mockedAnalyzeDomain.mockResolvedValue({
      classification: "web-application",
      specializations: [],
      requiredRoles: [],
      requiredMcpServers: [],
      techStack: ["typescript"],
    });

    const state = createInitialState("Something vague");
    const result = await runIdeation(state, makeConfig());

    expect(result.success).toBe(true);
    expect(mockedQuery).toHaveBeenCalledTimes(2);
    expect(result.state.spec?.summary).toContain("todo app");
  });

  it("returns failure when initial response and repair output are both invalid", async () => {
    mockedQuery
      .mockReturnValueOnce(makeMockQueryIterator("{ invalid json }") as any)
      .mockReturnValueOnce(makeMockQueryIterator("still not json") as any);

    mockedAnalyzeDomain.mockResolvedValue({
      classification: "web-application",
      specializations: [],
      requiredRoles: [],
      requiredMcpServers: [],
      techStack: ["typescript"],
    });

    const state = createInitialState("Build something");
    const result = await runIdeation(state, makeConfig());

    expect(result.success).toBe(false);
    expect(mockedQuery).toHaveBeenCalledTimes(2);
    expect(result.error).toContain("Invalid spec JSON");
  });
});
