import { describe, it, expect, vi, beforeEach } from "vitest";
import { createInitialState } from "../../src/state/project-state.js";
import type { Config } from "../../src/utils/config.js";
import type { ProjectState } from "../../src/state/project-state.js";

// Mock the Agent SDK
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

// Mock crypto.randomUUID for deterministic deployment IDs
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  let counter = 0;
  return {
    ...actual,
    randomUUID: () => `test-uuid-${++counter}`,
  };
});

const { query } = await import("@anthropic-ai/claude-agent-sdk");
const { runDeployment } = await import("../../src/phases/deployment.js");

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
              total_cost_usd: 0.05,
              num_turns: 3,
            },
            done: false,
          };
        },
      };
    },
    close() {},
  };
}

describe("Deployment Phase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deploys to staging and transitions to ab-testing", async () => {
    mockedQuery.mockReturnValue(
      makeMockQueryIterator(
        "Building project...\nDeploying to staging...\nDEPLOYED: https://staging.example.com"
      ) as any
    );

    const state: ProjectState = {
      ...createInitialState("Build a store"),
      currentPhase: "staging",
      deployments: [],
    };

    const result = await runDeployment(state, makeConfig());

    expect(result.success).toBe(true);
    expect(result.nextPhase).toBe("ab-testing");
    expect(result.state.deployments).toHaveLength(1);
    expect(result.state.deployments[0]!.environment).toBe("staging");
    expect(result.state.deployments[0]!.status).toBe("deployed");
    expect(result.state.deployments[0]!.url).toBe("https://staging.example.com");
  });

  it("deploys to production and transitions to monitoring", async () => {
    mockedQuery.mockReturnValue(
      makeMockQueryIterator(
        "Building project...\nDeploying to production...\nDEPLOYED: https://app.example.com"
      ) as any
    );

    const state: ProjectState = {
      ...createInitialState("Build a store"),
      currentPhase: "production",
      deployments: [],
    };

    const result = await runDeployment(state, makeConfig());

    expect(result.success).toBe(true);
    expect(result.nextPhase).toBe("monitoring");
    expect(result.state.deployments).toHaveLength(1);
    expect(result.state.deployments[0]!.environment).toBe("production");
    expect(result.state.deployments[0]!.status).toBe("deployed");
  });

  it("handles deployment failure from FAILED response", async () => {
    mockedQuery.mockReturnValue(
      makeMockQueryIterator(
        "Building project...\nFAILED: Docker build error - missing Dockerfile"
      ) as any
    );

    const state: ProjectState = {
      ...createInitialState("Build a store"),
      currentPhase: "staging",
      deployments: [],
    };

    const result = await runDeployment(state, makeConfig());

    expect(result.success).toBe(false);
    expect(result.error).toContain("Deployment failed");
    expect(result.state.deployments).toHaveLength(1);
    expect(result.state.deployments[0]!.status).toBe("failed");
  });

  it("handles query error gracefully and records failed deployment", async () => {
    mockedQuery.mockReturnValue({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            throw new Error("Network timeout");
          },
        };
      },
      close() {},
    } as any);

    const state: ProjectState = {
      ...createInitialState("Build a store"),
      currentPhase: "production",
      deployments: [],
    };

    const result = await runDeployment(state, makeConfig());

    expect(result.success).toBe(false);
    expect(result.error).toContain("Deployment query failed");
    expect(result.state.deployments).toHaveLength(1);
    expect(result.state.deployments[0]!.status).toBe("failed");
    expect(result.state.deployments[0]!.environment).toBe("production");
  });
});
