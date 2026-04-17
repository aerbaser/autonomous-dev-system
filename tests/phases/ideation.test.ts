import { describe, it, expect, vi, beforeEach } from "vitest";
import { createInitialState } from "../../src/state/project-state.js";
import type { Config } from "../../src/utils/config.js";
import type { DomainAnalysis } from "../../src/state/project-state.js";

// Mock the Agent SDK
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

// Mock analyzeDomain so we can drive its outcome per test.
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

function makeDomain(): DomainAnalysis {
  return {
    classification: "web-application",
    specializations: ["chat"],
    requiredRoles: [],
    requiredMcpServers: [],
    techStack: ["typescript"],
  };
}

function validSpecJson(): string {
  return JSON.stringify({
    summary: "A test spec for a chat app",
    targetAudience: {
      primaryPersona: "casual users",
      secondaryPersonas: [],
      marketSize: "small",
    },
    competitiveAnalysis: {
      directCompetitors: [
        {
          name: "CompetitorA",
          strengths: ["s1"],
          weaknesses: ["w1"],
          differentiator: "faster",
        },
      ],
      ourEdge: "simplicity",
    },
    mvpScope: {
      included: ["send messages"],
      excluded: ["voice calls"],
      successMetrics: ["100 DAU"],
    },
    techStackRecommendation: {
      rationale: "well-known stack",
      recommended: ["TypeScript", "Next.js"],
      alternatives: ["SvelteKit"],
    },
    userStories: [
      {
        id: "US-001",
        title: "Send message",
        description: "As a user, I want to send messages so that I can chat",
        acceptanceCriteria: [
          "Given the app, when I type and press Enter, then the message is sent",
          "Given an empty input, when I press Enter, then nothing happens",
        ],
        priority: "must",
      },
    ],
    nonFunctionalRequirements: [
      "Performance: p95 under 200ms",
      "Security: OWASP top-10 mitigations in place",
      "Scalability: handles 10k concurrent users",
      "Observability: structured logs",
    ],
  });
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
              session_id: "ideation-sess",
              total_cost_usd: 0.02,
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

  it("normal success: both spec and domain succeed", async () => {
    mockedAnalyzeDomain.mockResolvedValue(makeDomain());
    mockedQuery.mockReturnValue(makeMockQueryIterator(validSpecJson()) as any);

    const state = createInitialState("Build a chat app");
    const result = await runIdeation(state, makeConfig());

    expect(result.success).toBe(true);
    expect(result.nextPhase).toBe("specification");
    expect(result.state.spec).toBeDefined();
    expect(result.state.spec?.domain.classification).toBe("web-application");
    expect(result.state.spec?.userStories.length).toBeGreaterThan(0);
  });

  it("spec succeeds, domain rejects: warn + continue with default domain", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockedAnalyzeDomain.mockRejectedValue(new Error("domain analyzer blew up"));
    mockedQuery.mockReturnValue(makeMockQueryIterator(validSpecJson()) as any);

    const state = createInitialState("Build a chat app");
    const result = await runIdeation(state, makeConfig());

    expect(result.success).toBe(true);
    expect(result.state.spec).toBeDefined();
    // Falls back to default domain classification.
    expect(result.state.spec?.domain.classification).toBe("web-application");
    expect(result.state.spec?.domain.specializations).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("spec rejects: returns failed PhaseResult regardless of domain", async () => {
    mockedAnalyzeDomain.mockResolvedValue(makeDomain());
    // Stream throws on first read -> consumeQuery throws -> phase returns failure.
    mockedQuery.mockReturnValue({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            throw new Error("SDK stream error");
          },
        };
      },
      close() {},
    } as any);

    const state = createInitialState("Build a chat app");
    const result = await runIdeation(state, makeConfig());

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("Failed to generate spec");
  });

  it("abort signal: returns aborted result", async () => {
    mockedAnalyzeDomain.mockImplementation(async (_idea, _cfg, _signal) => {
      // Simulate the query path propagating abort: domain analyzer re-throws
      // QueryAbortedError. We import the real class from sdk-helpers so the
      // instanceof check in ideation works.
      const { QueryAbortedError } = await import("../../src/utils/sdk-helpers.js");
      throw new QueryAbortedError("test-abort");
    });
    // Spec also throws QueryAbortedError so both promises reject with abort.
    mockedQuery.mockReturnValue({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            const { QueryAbortedError } = await import("../../src/utils/sdk-helpers.js");
            throw new QueryAbortedError("test-abort");
          },
        };
      },
      close() {},
    } as any);

    const ctrl = new AbortController();
    ctrl.abort("test-abort");
    const state = createInitialState("Build a chat app");
    const result = await runIdeation(state, makeConfig(), { signal: ctrl.signal });

    expect(result.success).toBe(false);
    expect(result.error).toBe("aborted");
  });
});
