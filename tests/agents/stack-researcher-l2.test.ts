import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/utils/config.js";
import type { ArchDesign, DomainAnalysis } from "../../src/state/project-state.js";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

const { query } = await import("@anthropic-ai/claude-agent-sdk");
const { researchStack } = await import("../../src/agents/stack-researcher.js");
const { MemoryStore } = await import("../../src/state/memory-store.js");
const { LayeredMemory } = await import("../../src/memory/layers.js");

const mockedQuery = vi.mocked(query);

function makeConfig(overrides?: Partial<Config["memory"]>): Config {
  return {
    model: "claude-sonnet-4-6",
    subagentModel: "claude-sonnet-4-6",
    selfImprove: { enabled: false, maxIterations: 50, nightlyOptimize: false },
    projectDir: ".",
    stateDir: ".autonomous-dev",
    memory: {
      enabled: true,
      maxDocuments: 500,
      maxDocumentSizeKb: 100,
      layers: { enabled: true },
      ...(overrides ?? {}),
    },
    rubrics: { enabled: false, maxIterations: 3 },
  } as Config;
}

function makeArch(): ArchDesign {
  return {
    techStack: { language: "typescript", runtime: "node", framework: "react" },
    components: ["frontend"],
    apiContracts: "REST",
    databaseSchema: "",
    fileStructure: "src/",
  };
}

function makeDomain(): DomainAnalysis {
  return {
    classification: "saas",
    specializations: ["task-management"],
    requiredRoles: [],
    requiredMcpServers: ["playwright"],
    techStack: ["typescript"],
  };
}

function failingQueryStream() {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<never> {
          throw new Error("forced-fallback");
        },
      };
    },
  } as any;
}

let tmpDir: string;

describe("researchStack — L2 fact persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = join(tmpdir(), `ads-stack-researcher-l2-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes detected facts to L2 when memory is provided (fallback path)", async () => {
    mockedQuery.mockReturnValue(failingQueryStream());
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const store = new MemoryStore(tmpDir);
    const layered = new LayeredMemory(store, tmpDir);

    const env = await researchStack(makeArch(), makeDomain(), makeConfig(), undefined, layered);

    expect(env.lspServers.length).toBeGreaterThan(0);

    const lspFact = await layered.l2.getFact("stack.lsp.typescript");
    expect(lspFact).toBe("vtsls");

    const domainFact = await layered.l2.getFact("stack.domain");
    expect(domainFact).toBe("saas");

    const techFact = await layered.l2.getFact("stack.tech");
    expect(techFact).toContain("typescript");

    const mcpFact = await layered.l2.getFact("stack.mcp.playwright");
    expect(mcpFact).toBe("npm:@playwright/mcp@latest");

    const factLogs = logSpy.mock.calls.filter((args) =>
      typeof args[0] === "string" && args[0].startsWith("[stack-researcher] Wrote L2 fact:"),
    );
    expect(factLogs.length).toBeGreaterThan(0);

    logSpy.mockRestore();
  });

  it("does not write facts when memory is absent", async () => {
    mockedQuery.mockReturnValue(failingQueryStream());
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const env = await researchStack(makeArch(), makeDomain(), makeConfig());

    expect(env).toBeDefined();

    const factLogs = logSpy.mock.calls.filter((args) =>
      typeof args[0] === "string" && args[0].startsWith("[stack-researcher] Wrote L2 fact:"),
    );
    expect(factLogs).toHaveLength(0);

    logSpy.mockRestore();
  });

  it("skips L2 writes when config.memory.layers.enabled is false", async () => {
    mockedQuery.mockReturnValue(failingQueryStream());
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const store = new MemoryStore(tmpDir);
    const layered = new LayeredMemory(store, tmpDir);

    const gatedConfig = makeConfig({ layers: { enabled: false } });
    const env = await researchStack(makeArch(), makeDomain(), gatedConfig, undefined, layered);

    expect(env).toBeDefined();

    const lspFact = await layered.l2.getFact("stack.lsp.typescript");
    expect(lspFact).toBeNull();

    const factLogs = logSpy.mock.calls.filter((args) =>
      typeof args[0] === "string" && args[0].startsWith("[stack-researcher] Wrote L2 fact:"),
    );
    expect(factLogs).toHaveLength(0);

    logSpy.mockRestore();
  });

  it("skips L2 writes when config.memory.enabled is false", async () => {
    mockedQuery.mockReturnValue(failingQueryStream());
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const store = new MemoryStore(tmpDir);
    const layered = new LayeredMemory(store, tmpDir);

    const gatedConfig = makeConfig({ enabled: false });
    const env = await researchStack(makeArch(), makeDomain(), gatedConfig, undefined, layered);

    expect(env).toBeDefined();

    const lspFact = await layered.l2.getFact("stack.lsp.typescript");
    expect(lspFact).toBeNull();

    const factLogs = logSpy.mock.calls.filter((args) =>
      typeof args[0] === "string" && args[0].startsWith("[stack-researcher] Wrote L2 fact:"),
    );
    expect(factLogs).toHaveLength(0);

    logSpy.mockRestore();
  });
});
