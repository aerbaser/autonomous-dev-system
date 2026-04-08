import { describe, it, expect, vi, beforeEach } from "vitest";
import { createInitialState } from "../../src/state/project-state.js";
import type { Config } from "../../src/utils/config.js";
import type { ProjectState } from "../../src/state/project-state.js";

// Mock the Agent SDK
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

// Mock getMcpServerConfigs
vi.mock("../../src/environment/mcp-manager.js", () => ({
  getMcpServerConfigs: vi.fn().mockReturnValue({}),
}));

const { query } = await import("@anthropic-ai/claude-agent-sdk");
const { runTesting } = await import("../../src/phases/testing.js");

const mockedQuery = vi.mocked(query);

function makeConfig(): Config {
  return {
    model: "claude-sonnet-4-6",
    subagentModel: "claude-sonnet-4-6",
    selfImprove: { enabled: false, maxIterations: 50, nightlyOptimize: false },
    projectDir: ".",
    stateDir: ".autonomous-dev",
  };
}

function makeStateWithSpec(): ProjectState {
  const state = createInitialState("Build a chat app");
  return {
    ...state,
    spec: {
      summary: "A chat application",
      userStories: [
        {
          id: "US-001",
          title: "Send message",
          description: "As a user, I want to send messages",
          acceptanceCriteria: ["Given the chat, when I type and send, then the message appears"],
          priority: "must",
        },
      ],
      nonFunctionalRequirements: ["Performance: real-time delivery"],
      domain: {
        classification: "communication",
        specializations: ["real-time"],
        requiredRoles: [],
        requiredMcpServers: [],
        techStack: ["typescript"],
      },
    },
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
              session_id: "test-session",
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

describe("Testing Phase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns nextPhase 'review' when tests PASS", async () => {
    mockedQuery.mockReturnValue(
      makeMockQueryIterator(
        "Running tests...\n\nAll 42 tests passed.\nCoverage: 87%\n\nPASS"
      ) as any
    );

    const state = makeStateWithSpec();
    const result = await runTesting(state, makeConfig());

    expect(result.success).toBe(true);
    expect(result.nextPhase).toBe("review");
  });

  it("returns nextPhase 'development' when tests FAIL", async () => {
    mockedQuery.mockReturnValue(
      makeMockQueryIterator(
        "Running tests...\n\n3 tests failed.\n\nFAIL: auth module has 3 failing tests"
      ) as any
    );

    const state = makeStateWithSpec();
    const result = await runTesting(state, makeConfig());

    expect(result.success).toBe(true);
    expect(result.nextPhase).toBe("development");
  });

  it("returns failure when spec is missing", async () => {
    const state = createInitialState("Build something");
    const result = await runTesting(state, makeConfig());

    expect(result.success).toBe(false);
    expect(result.error).toContain("Spec required");
  });

  it("falls back to development when query throws", async () => {
    mockedQuery.mockReturnValue({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            throw new Error("SDK connection error");
          },
        };
      },
      close() {},
    } as any);

    const state = makeStateWithSpec();
    const result = await runTesting(state, makeConfig());

    // Error handling sends back to development
    expect(result.success).toBe(true);
    expect(result.nextPhase).toBe("development");
  });
});
