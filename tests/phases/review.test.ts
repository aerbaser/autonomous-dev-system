import { describe, it, expect, vi, beforeEach } from "vitest";
import { createInitialState } from "../../src/state/project-state.js";
import type { Config } from "../../src/utils/config.js";

// Mock the Agent SDK
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

const { query } = await import("@anthropic-ai/claude-agent-sdk");
const { runReview } = await import("../../src/phases/review.js");

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

describe("Review Phase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns nextPhase 'staging' when review approves", async () => {
    mockedQuery.mockReturnValue(
      makeMockQueryIterator(
        "## Code Review\n\nCRITICAL: none\nWARNINGS: 2 minor issues\n\nAPPROVE"
      ) as any
    );

    const state = createInitialState("Build a blog");
    const result = await runReview(state, makeConfig());

    expect(result.success).toBe(true);
    expect(result.nextPhase).toBe("staging");
  });

  it("returns nextPhase 'development' when review requests changes", async () => {
    mockedQuery.mockReturnValue(
      makeMockQueryIterator(
        "## Code Review\n\nCRITICAL: SQL injection in user input handler\n\nREQUEST_CHANGES: Fix SQL injection vulnerability"
      ) as any
    );

    const state = createInitialState("Build a blog");
    const result = await runReview(state, makeConfig());

    expect(result.success).toBe(true);
    expect(result.nextPhase).toBe("development");
  });

  it("returns nextPhase 'development' when query throws", async () => {
    mockedQuery.mockReturnValue({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            throw new Error("SDK error");
          },
        };
      },
      close() {},
    } as any);

    const state = createInitialState("Build a blog");
    const result = await runReview(state, makeConfig());

    // Error is now properly reported (not swallowed)
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
