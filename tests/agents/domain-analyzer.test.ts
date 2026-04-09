import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Config } from "../../src/utils/config.js";

// Mock SDK
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

const { query } = await import("@anthropic-ai/claude-agent-sdk");
const { analyzeDomain, generateDomainAgents } = await import("../../src/agents/domain-analyzer.js");

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

const VALID_DOMAIN_JSON = JSON.stringify({
  classification: "fintech",
  specializations: ["trading", "risk management"],
  requiredRoles: ["financial-analyst"],
  requiredMcpServers: ["posthog"],
  techStack: ["python", "pandas"],
});

describe("analyzeDomain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns parsed domain from valid JSON response", async () => {
    mockedQuery.mockReturnValue(makeQueryStream(VALID_DOMAIN_JSON));
    const domain = await analyzeDomain("Build a trading platform", makeConfig());

    expect(domain.classification).toBe("fintech");
    expect(domain.specializations).toContain("trading");
    expect(domain.requiredRoles).toContain("financial-analyst");
    expect(domain.requiredMcpServers).toContain("posthog");
    expect(domain.techStack).toContain("python");
  });

  it("returns default domain when query throws", async () => {
    mockedQuery.mockReturnValue({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            throw new Error("API error");
          },
        };
      },
    } as any);

    const domain = await analyzeDomain("some idea", makeConfig());
    expect(domain.classification).toBeDefined();
    expect(Array.isArray(domain.specializations)).toBe(true);
  });

  it("returns default domain when response contains no JSON", async () => {
    mockedQuery.mockReturnValue(makeQueryStream("I cannot analyze this project."));
    const domain = await analyzeDomain("some idea", makeConfig());

    expect(domain.classification).toBeDefined();
    expect(Array.isArray(domain.requiredRoles)).toBe(true);
  });

  it("returns default domain when JSON does not match schema", async () => {
    mockedQuery.mockReturnValue(makeQueryStream('{"wrong": "shape"}'));
    const domain = await analyzeDomain("some idea", makeConfig());

    expect(domain.classification).toBeDefined();
  });

  it("works without config (undefined)", async () => {
    mockedQuery.mockReturnValue(makeQueryStream(VALID_DOMAIN_JSON));
    const domain = await analyzeDomain("trading platform");

    expect(domain.classification).toBe("fintech");
  });
});

describe("generateDomainAgents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when domain has no required roles", async () => {
    const domain = {
      classification: "generic",
      specializations: [],
      requiredRoles: [],
      requiredMcpServers: [],
      techStack: [],
    };
    const agents = await generateDomainAgents("some idea", domain);
    expect(agents).toEqual([]);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("returns parsed agent blueprints from valid response", async () => {
    const agentsJson = JSON.stringify([
      {
        name: "financial-analyst",
        role: "Financial Data Analyst",
        systemPrompt: "You are a financial analyst...",
        tools: ["Read", "Bash"],
        evaluationCriteria: ["Uses decimal arithmetic", "Validates inputs", "Documents sources"],
      },
    ]);
    mockedQuery.mockReturnValue(makeQueryStream(agentsJson));

    const domain = {
      classification: "fintech",
      specializations: ["trading"],
      requiredRoles: ["financial-analyst"],
      requiredMcpServers: [],
      techStack: [],
    };
    const agents = await generateDomainAgents("trading app", domain, makeConfig());

    expect(agents).toHaveLength(1);
    expect(agents[0]!.name).toBe("financial-analyst");
    expect(agents[0]!.role).toBe("Financial Data Analyst");
  });

  it("returns empty array on query failure", async () => {
    mockedQuery.mockReturnValue({
      [Symbol.asyncIterator]() {
        return { async next() { throw new Error("API down"); } };
      },
    } as any);

    const domain = {
      classification: "fintech",
      specializations: [],
      requiredRoles: ["analyst"],
      requiredMcpServers: [],
      techStack: [],
    };
    const agents = await generateDomainAgents("idea", domain, makeConfig());
    expect(agents).toEqual([]);
  });
});
