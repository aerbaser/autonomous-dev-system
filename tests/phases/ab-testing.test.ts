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
const { runABTesting } = await import("../../src/phases/ab-testing.js");

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

function makeQueryStream(resultText: string) {
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
              total_cost_usd: 0.005,
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

function makeStateWithSpec(): ProjectState {
  const state = createInitialState("Build a SaaS product");
  return {
    ...state,
    spec: {
      summary: "A SaaS product",
      userStories: [],
      nonFunctionalRequirements: [],
      domain: {
        classification: "saas",
        specializations: [],
        requiredRoles: [],
        requiredMcpServers: [],
        techStack: [],
      },
    },
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

describe("AB Testing Phase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("design new experiment", () => {
    it("creates A/B test from valid JSON response", async () => {
      const design = JSON.stringify({
        name: "checkout-cta-test",
        hypothesis: "Adding urgency to CTA will increase conversion by 10%",
        variants: ["control", "variant_a"],
        featureFlagKey: "checkout-cta-flag",
        primaryMetric: "conversion_rate",
        minimumDetectableEffect: 0.05,
      });
      mockedQuery.mockReturnValue(makeQueryStream(design));

      const state = makeStateWithSpec();
      const result = await runABTesting(state, makeConfig());

      expect(result.success).toBe(true);
      expect(result.nextPhase).toBe("analysis");
      expect(result.state.abTests).toHaveLength(1);
      expect(result.state.abTests[0]!.name).toBe("checkout-cta-test");
      expect(result.state.abTests[0]!.hypothesis).toContain("urgency");
      expect(result.state.abTests[0]!.status).toBe("running");
    });

    it("returns failure when query returns no JSON", async () => {
      mockedQuery.mockReturnValue(makeQueryStream("I cannot design a test right now."));

      const result = await runABTesting(makeStateWithSpec(), makeConfig());

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("returns failure when JSON does not match schema", async () => {
      mockedQuery.mockReturnValue(makeQueryStream('{"wrong": "shape"}'));

      const result = await runABTesting(makeStateWithSpec(), makeConfig());

      expect(result.success).toBe(false);
    });

    it("returns failure when query throws", async () => {
      mockedQuery.mockReturnValue({
        [Symbol.asyncIterator]() {
          return {
            async next() { throw new Error("API error"); },
          };
        },
      } as any);

      const result = await runABTesting(makeStateWithSpec(), makeConfig());

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to design A/B test");
    });

    it("returns costUsd from query", async () => {
      const design = JSON.stringify({
        name: "test",
        hypothesis: "H",
        variants: ["a", "b"],
        featureFlagKey: "flag",
        primaryMetric: "conversion",
        minimumDetectableEffect: 0.05,
      });
      mockedQuery.mockReturnValue(makeQueryStream(design));

      const result = await runABTesting(makeStateWithSpec(), makeConfig());

      expect(result.costUsd).toBe(0.005);
    });
  });

  describe("analyze running tests", () => {
    it("routes to analysis when active tests exist", async () => {
      const analysis = JSON.stringify([
        {
          testId: "test-1",
          winner: "variant_a",
          pValue: 0.02,
          metrics: { conversion_rate_control: 0.1, conversion_rate_variant: 0.15 },
          recommendation: "Roll out variant",
        },
      ]);
      mockedQuery.mockReturnValue(makeQueryStream(analysis));

      const state: ProjectState = {
        ...makeStateWithSpec(),
        abTests: [
          {
            id: "test-1",
            name: "checkout-cta",
            hypothesis: "Some hypothesis",
            variants: ["control", "variant_a"],
            featureFlagKey: "flag",
            status: "running",
          },
        ],
      };

      const result = await runABTesting(state, makeConfig());

      expect(result.success).toBe(true);
    });
  });
});
