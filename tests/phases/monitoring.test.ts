import { describe, it, expect, vi, beforeEach } from "vitest";
import { createInitialState } from "../../src/state/project-state.js";
import type { ProjectState } from "../../src/state/project-state.js";
import type { Config } from "../../src/utils/config.js";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("../../src/environment/mcp-manager.js", () => ({
  getMcpServerConfigs: vi.fn().mockReturnValue({}),
}));

const { query } = await import("@anthropic-ai/claude-agent-sdk");
const { runMonitoring } = await import("../../src/phases/monitoring.js");

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
              total_cost_usd: 0.01,
              num_turns: 1,
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

function makeStateWithDeployment(): ProjectState {
  const state = createInitialState("Build an app");
  return {
    ...state,
    deployments: [
      {
        id: "d1",
        environment: "production",
        url: "https://app.example.com",
        timestamp: new Date().toISOString(),
        status: "deployed",
      },
    ],
  };
}

describe("Monitoring Phase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("structured output path", () => {
    it("returns healthy status with no nextPhase", async () => {
      mockedQuery.mockReturnValue(
        makeQueryStream("All systems nominal.", { status: "healthy", description: "All OK" })
      );

      const result = await runMonitoring(makeStateWithDeployment(), makeConfig());

      expect(result.success).toBe(true);
      expect(result.nextPhase).toBeUndefined();
    });

    it("routes to development when regression detected", async () => {
      mockedQuery.mockReturnValue(
        makeQueryStream("Regression detected.", { status: "regression", description: "Error rate spiked" })
      );

      const result = await runMonitoring(makeStateWithDeployment(), makeConfig());

      expect(result.success).toBe(true);
      expect(result.nextPhase).toBe("development");
    });

    it("routes to development when improvement suggested", async () => {
      mockedQuery.mockReturnValue(
        makeQueryStream("Improvement suggested.", { status: "improvement", description: "Add caching" })
      );

      const result = await runMonitoring(makeStateWithDeployment(), makeConfig());

      expect(result.success).toBe(true);
      expect(result.nextPhase).toBe("development");
    });
  });

  describe("text fallback path", () => {
    it("parses REGRESSION: prefix from last line", async () => {
      mockedQuery.mockReturnValue(
        makeQueryStream("Checking metrics...\nREGRESSION: error rate increased")
      );

      const result = await runMonitoring(makeStateWithDeployment(), makeConfig());

      expect(result.success).toBe(true);
      expect(result.nextPhase).toBe("development");
    });

    it("parses IMPROVEMENT: prefix from last line", async () => {
      mockedQuery.mockReturnValue(
        makeQueryStream("Checking metrics...\nIMPROVEMENT: add dark mode")
      );

      const result = await runMonitoring(makeStateWithDeployment(), makeConfig());

      expect(result.success).toBe(true);
      expect(result.nextPhase).toBe("development");
    });

    it("defaults to healthy when no prefix matched", async () => {
      mockedQuery.mockReturnValue(
        makeQueryStream("All metrics look normal. Everything is running fine.")
      );

      const result = await runMonitoring(makeStateWithDeployment(), makeConfig());

      expect(result.success).toBe(true);
      expect(result.nextPhase).toBeUndefined();
    });
  });

  describe("error handling", () => {
    it("returns failure when query throws", async () => {
      mockedQuery.mockReturnValue({
        [Symbol.asyncIterator]() {
          return { async next() { throw new Error("API error"); } };
        },
      } as any);

      const result = await runMonitoring(makeStateWithDeployment(), makeConfig());

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("returns costUsd from query", async () => {
      mockedQuery.mockReturnValue(
        makeQueryStream("Healthy", { status: "healthy", description: "OK" })
      );

      const result = await runMonitoring(makeStateWithDeployment(), makeConfig());

      expect(result.costUsd).toBe(0.01);
    });
  });
});
