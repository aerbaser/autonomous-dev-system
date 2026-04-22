import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Config } from "../../src/utils/config.js";
import { createInitialState } from "../../src/state/project-state.js";
import type { ProjectState } from "../../src/state/project-state.js";

// Mock the Agent SDK before importing the handler under test.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));

const { query } = await import("@anthropic-ai/claude-agent-sdk");
const mockedQuery = vi.mocked(query);
const { runSpecification } = await import("../../src/phases/specification.js");

function makeStream(resultText: string) {
  return {
    [Symbol.asyncIterator]() {
      let done = false;
      return {
        async next() {
          if (done) return { value: undefined, done: true as const };
          done = true;
          return {
            value: {
              type: "result" as const,
              subtype: "success" as const,
              result: resultText,
              session_id: "specification-session",
              total_cost_usd: 0.001,
              num_turns: 1,
            },
            done: false as const,
          };
        },
      };
    },
    close() {},
  } as any;
}

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

function makeStateWithSpec(): ProjectState {
  const base = createInitialState("build a todo app with tags");
  return {
    ...base,
    spec: {
      summary: "A todo app with tagged tasks and due dates",
      userStories: [
        {
          id: "US-001",
          title: "Create a task",
          description: "Users can add a new task to their list",
          priority: "must",
          acceptanceCriteria: [
            "Given a logged-in user, When they submit a task, Then it appears in the list",
          ],
        },
      ],
      nonFunctionalRequirements: ["Fast response times"],
      domain: {
        classification: "productivity",
        specializations: [],
        requiredRoles: [],
        requiredMcpServers: [],
        techStack: [],
      },
    },
  };
}

const validDetailedSpec = {
  refinedUserStories: [
    {
      id: "US-001",
      title: "Create a task",
      acceptanceCriteria: [
        "Given a logged-in user, When they submit a task with a title, Then it appears at the top of their list",
        "Given an empty title, When they attempt to submit, Then an inline error is shown and the task is NOT created",
        "Given a network failure during submit, When the request is retried, Then no duplicate task is created",
      ],
    },
  ],
  refinedNonFunctionalRequirements: [
    {
      category: "performance",
      requirement: "P95 response time under load",
      threshold: "p95 < 200ms at 100 RPS",
    },
  ],
  outOfScope: [
    "Multi-tenant task sharing",
    "Offline mode with conflict resolution",
  ],
  integrationBoundaries: [
    {
      name: "Auth provider",
      description: "OAuth2 via Clerk; failure → 401 + prompt to re-authenticate",
    },
  ],
};

describe("runSpecification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns success and populates state.spec.detailed with parsed DetailedSpec", async () => {
    mockedQuery.mockReturnValue(makeStream(JSON.stringify(validDetailedSpec)));

    const result = await runSpecification(makeStateWithSpec(), makeConfig());

    expect(result.success).toBe(true);
    expect(result.nextPhase).toBe("architecture");
    expect(result.state.spec?.detailed).toEqual(validDetailedSpec);
    expect(mockedQuery).toHaveBeenCalledTimes(1);
  });

  it("returns failure when state.spec is missing", async () => {
    const stateNoSpec: ProjectState = { ...createInitialState("idea"), spec: null };
    const result = await runSpecification(stateNoSpec, makeConfig());

    expect(result.success).toBe(false);
    expect(result.error).toBe("No spec found. Run ideation first.");
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("returns failure when the LLM response contains no valid JSON", async () => {
    mockedQuery.mockReturnValue(
      makeStream("Here is the spec as prose — no JSON. Sorry."),
    );

    const result = await runSpecification(makeStateWithSpec(), makeConfig());

    expect(result.success).toBe(false);
    expect(result.error).toBe("specification: no valid JSON in LLM output");
  });

  it("returns failure when the extracted JSON does not satisfy DetailedSpecSchema", async () => {
    // Missing required `integrationBoundaries` field entirely — schema rejects.
    // (Schema has no .min(N) on outOfScope/AC, so we exercise a structural
    // violation instead of a count violation.)
    const { integrationBoundaries: _omit, ...malformed } = validDetailedSpec;
    mockedQuery.mockReturnValue(makeStream(JSON.stringify(malformed)));

    const result = await runSpecification(makeStateWithSpec(), makeConfig());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/specification: invalid DetailedSpec JSON/);
  });
});
