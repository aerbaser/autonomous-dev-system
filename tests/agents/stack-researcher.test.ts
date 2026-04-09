import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Config } from "../../src/utils/config.js";
import type { ArchDesign, DomainAnalysis } from "../../src/state/project-state.js";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

const { query } = await import("@anthropic-ai/claude-agent-sdk");
const { researchStack } = await import("../../src/agents/stack-researcher.js");

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

function makeArch(): ArchDesign {
  return {
    techStack: { language: "TypeScript", framework: "Next.js", database: "PostgreSQL" },
    components: ["frontend", "api", "db"],
    apiContracts: "REST",
    databaseSchema: "tasks",
    fileStructure: "src/",
  };
}

function makeDomain(): DomainAnalysis {
  return {
    classification: "saas",
    specializations: ["task management"],
    requiredRoles: [],
    requiredMcpServers: ["playwright"],
    techStack: ["typescript"],
  };
}

const VALID_STACK_JSON = JSON.stringify({
  lspServers: [
    { language: "typescript", server: "vtsls", installCommand: "npm i -g vtsls", reason: "TS support" },
  ],
  mcpServers: [
    {
      name: "playwright",
      source: "npm:@playwright/mcp",
      config: { command: "npx", args: ["@playwright/mcp@latest"] },
      reason: "E2E testing",
    },
  ],
  plugins: [
    { name: "testbench", source: "marketplace", scope: "project", reason: "Test generation" },
  ],
  openSourceTools: [
    { name: "some-tool", repo: "https://github.com/user/repo", type: "skill", integrationPlan: "Integrate as a Claude skill" },
  ],
  claudeMdSuggestions: ["Use TypeScript strict mode", "Prefer const"],
});

describe("researchStack", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns parsed StackEnvironment from valid response", async () => {
    mockedQuery.mockReturnValue(makeQueryStream(VALID_STACK_JSON));

    const env = await researchStack(makeArch(), makeDomain(), makeConfig());

    expect(env.lspServers).toHaveLength(1);
    expect(env.lspServers[0]!.server).toBe("vtsls");
    expect(env.mcpServers).toHaveLength(1);
    expect(env.mcpServers[0]!.name).toBe("playwright");
    expect(env.plugins).toHaveLength(1);
    expect(env.openSourceTools).toHaveLength(1);
    expect(env.claudeMd).toContain("TypeScript strict mode");
  });

  it("LSP servers have installed=false by default", async () => {
    mockedQuery.mockReturnValue(makeQueryStream(VALID_STACK_JSON));

    const env = await researchStack(makeArch(), makeDomain(), makeConfig());

    expect(env.lspServers[0]!.installed).toBe(false);
    expect(env.mcpServers[0]!.installed).toBe(false);
    expect(env.plugins[0]!.installed).toBe(false);
  });

  it("returns default environment when query throws", async () => {
    mockedQuery.mockReturnValue({
      [Symbol.asyncIterator]() {
        return { async next() { throw new Error("API error"); } };
      },
    } as any);

    const env = await researchStack(makeArch(), makeDomain(), makeConfig());

    expect(env.lspServers).toBeDefined();
    expect(Array.isArray(env.lspServers)).toBe(true);
  });

  it("returns default environment when response contains no JSON", async () => {
    mockedQuery.mockReturnValue(makeQueryStream("No tools found."));

    const env = await researchStack(makeArch(), makeDomain(), makeConfig());

    expect(env).toBeDefined();
    expect(Array.isArray(env.lspServers)).toBe(true);
  });

  it("works without config", async () => {
    mockedQuery.mockReturnValue(makeQueryStream(VALID_STACK_JSON));

    const env = await researchStack(makeArch(), makeDomain());

    expect(env.lspServers).toHaveLength(1);
  });
});
