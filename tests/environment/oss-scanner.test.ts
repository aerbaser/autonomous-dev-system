import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Config } from "../../src/utils/config.js";
import type { ArchDesign, DomainAnalysis } from "../../src/state/project-state.js";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

const { query } = await import("@anthropic-ai/claude-agent-sdk");
const { scanOpenSource } = await import("../../src/environment/oss-scanner.js");

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

// oss-scanner uses raw `for await` on query() — it looks for result.result
function makeRawQueryStream(resultText: string) {
  return {
    [Symbol.asyncIterator]() {
      let done = false;
      return {
        async next() {
          if (done) return { value: undefined, done: true as const };
          done = true;
          return {
            value: { result: resultText, type: "result", subtype: "success" },
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
    techStack: { language: "TypeScript", framework: "Next.js" },
    components: ["frontend", "api"],
    apiContracts: "REST",
    databaseSchema: "",
    fileStructure: "src/",
  };
}

function makeDomain(): DomainAnalysis {
  return {
    classification: "saas",
    specializations: ["task management"],
    requiredRoles: [],
    requiredMcpServers: [],
    techStack: ["typescript"],
  };
}

const VALID_TOOLS_JSON = JSON.stringify([
  {
    name: "some-mcp-server",
    repo: "https://github.com/user/some-mcp-server",
    type: "mcp-server",
    integrationPlan: "Configure as MCP server for database access",
  },
  {
    name: "agent-framework",
    repo: "https://github.com/org/agent-framework",
    type: "agent",
    integrationPlan: "Use as base for custom agents",
  },
]);

describe("scanOpenSource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns parsed OssTool array from valid JSON array response", async () => {
    mockedQuery.mockReturnValue(makeRawQueryStream(`Here are the tools:\n${VALID_TOOLS_JSON}`));

    const tools = await scanOpenSource(makeArch(), makeDomain(), makeConfig());

    expect(tools).toHaveLength(2);
    expect(tools[0]!.name).toBe("some-mcp-server");
    expect(tools[0]!.type).toBe("mcp-server");
    expect(tools[0]!.integrated).toBe(false);
    expect(tools[1]!.name).toBe("agent-framework");
    expect(tools[1]!.type).toBe("agent");
  });

  it("returns empty array when response contains no JSON array", async () => {
    mockedQuery.mockReturnValue(makeRawQueryStream("No relevant tools found for this project."));

    const tools = await scanOpenSource(makeArch(), makeDomain(), makeConfig());

    expect(tools).toEqual([]);
  });

  it("returns empty array when JSON array is empty", async () => {
    mockedQuery.mockReturnValue(makeRawQueryStream("[]"));

    const tools = await scanOpenSource(makeArch(), makeDomain(), makeConfig());

    expect(tools).toEqual([]);
  });

  it("rejects arrays with invalid tool types (strict at LLM boundary)", async () => {
    // Strict-at-LLM-boundary (Stream 2): the previous `.catch("pattern")` on
    // the `type` field silently coerced bad values. That was removed, so a
    // single invalid entry now fails the whole-array safeParse and the scanner
    // surfaces the rejection via a warning and returns [].
    const json = JSON.stringify([
      {
        name: "weird-tool",
        repo: "https://github.com/user/weird",
        type: "completely-invalid-type",
        integrationPlan: "Use somehow",
      },
    ]);
    mockedQuery.mockReturnValue(makeRawQueryStream(json));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tools = await scanOpenSource(makeArch(), makeDomain(), makeConfig());
      expect(tools).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("returns empty array on malformed JSON", async () => {
    mockedQuery.mockReturnValue(makeRawQueryStream("[not valid json...]"));

    const tools = await scanOpenSource(makeArch(), makeDomain(), makeConfig());

    expect(tools).toEqual([]);
  });

  it("works without config", async () => {
    mockedQuery.mockReturnValue(makeRawQueryStream(VALID_TOOLS_JSON));

    const tools = await scanOpenSource(makeArch(), makeDomain());

    expect(tools).toHaveLength(2);
  });
});
