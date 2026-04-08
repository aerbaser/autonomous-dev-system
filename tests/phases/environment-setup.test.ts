import { describe, it, expect, vi, beforeEach } from "vitest";
import { createInitialState } from "../../src/state/project-state.js";
import type { Config } from "../../src/utils/config.js";
import type {
  ProjectState,
  ArchDesign,
  LspConfig,
  McpDiscovery,
  PluginDiscovery,
  OssTool,
} from "../../src/state/project-state.js";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DIR = join(tmpdir(), `ads-test-env-setup-${process.pid}`);

// Mock all external dependencies
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("../../src/agents/stack-researcher.js", () => ({
  researchStack: vi.fn(),
}));

vi.mock("../../src/environment/lsp-manager.js", () => ({
  installLspServers: vi.fn(),
}));

vi.mock("../../src/environment/mcp-manager.js", () => ({
  configureMcpServers: vi.fn(),
}));

vi.mock("../../src/environment/plugin-manager.js", () => ({
  installPlugins: vi.fn(),
}));

vi.mock("../../src/environment/oss-scanner.js", () => ({
  scanOpenSource: vi.fn(),
}));

vi.mock("../../src/environment/claude-md-generator.js", () => ({
  generateClaudeMd: vi.fn(),
}));

const { researchStack } = await import("../../src/agents/stack-researcher.js");
const { installLspServers } = await import("../../src/environment/lsp-manager.js");
const { configureMcpServers } = await import("../../src/environment/mcp-manager.js");
const { installPlugins } = await import("../../src/environment/plugin-manager.js");
const { scanOpenSource } = await import("../../src/environment/oss-scanner.js");
const { generateClaudeMd } = await import("../../src/environment/claude-md-generator.js");
const { runEnvironmentSetup } = await import("../../src/phases/environment-setup.js");

const mockedResearchStack = vi.mocked(researchStack);
const mockedInstallLspServers = vi.mocked(installLspServers);
const mockedConfigureMcpServers = vi.mocked(configureMcpServers);
const mockedInstallPlugins = vi.mocked(installPlugins);
const mockedScanOpenSource = vi.mocked(scanOpenSource);
const mockedGenerateClaudeMd = vi.mocked(generateClaudeMd);

const defaultArch: ArchDesign = {
  techStack: { language: "TypeScript", framework: "Next.js" },
  components: ["Frontend", "API"],
  apiContracts: "REST",
  databaseSchema: "CREATE TABLE ...",
  fileStructure: "src/",
};

const defaultLsp: LspConfig[] = [
  { language: "typescript", server: "vtsls", installCommand: "npm i -g vtsls", installed: false },
];

const defaultMcp: McpDiscovery[] = [
  {
    name: "playwright",
    source: "npm:@playwright/mcp",
    config: { command: "npx", args: ["@playwright/mcp"] },
    installed: false,
    reason: "E2E testing",
  },
];

const defaultPlugins: PluginDiscovery[] = [
  { name: "test-plugin", source: "marketplace", scope: "project", installed: false, reason: "testing" },
];

const defaultOss: OssTool[] = [
  { name: "oss-tool", repo: "https://github.com/test/tool", type: "pattern", integrationPlan: "Use as reference", integrated: false },
];

function makeConfig(): Config {
  return {
    model: "claude-sonnet-4-6",
    subagentModel: "claude-sonnet-4-6",
    selfImprove: { enabled: false, maxIterations: 50, nightlyOptimize: false },
    projectDir: TEST_DIR,
    stateDir: join(TEST_DIR, ".autonomous-dev"),
  };
}

function makeStateWithArchitecture(): ProjectState {
  const state = createInitialState("Build a task app");
  return {
    ...state,
    architecture: defaultArch,
    spec: {
      summary: "Task app",
      userStories: [],
      nonFunctionalRequirements: [],
      domain: {
        classification: "productivity",
        specializations: [],
        requiredRoles: [],
        requiredMcpServers: [],
        techStack: ["typescript"],
      },
    },
  };
}

describe("Environment Setup Phase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(join(TEST_DIR, ".autonomous-dev"), { recursive: true });

    // Default mocks that simulate successful setup
    mockedResearchStack.mockResolvedValue({
      lspServers: defaultLsp,
      mcpServers: defaultMcp,
      plugins: defaultPlugins,
      openSourceTools: defaultOss,
      claudeMd: "Use strict mode",
    });

    mockedInstallLspServers.mockReturnValue(
      defaultLsp.map((l) => ({ ...l, installed: true }))
    );

    mockedConfigureMcpServers.mockReturnValue(
      defaultMcp.map((m) => ({ ...m, installed: true }))
    );

    mockedInstallPlugins.mockReturnValue(
      defaultPlugins.map((p) => ({ ...p, installed: true }))
    );

    mockedScanOpenSource.mockResolvedValue(defaultOss);
    mockedGenerateClaudeMd.mockReturnValue(undefined);
  });

  it("calls LSP, MCP, and plugin managers on success", async () => {
    const state = makeStateWithArchitecture();
    const result = await runEnvironmentSetup(state, makeConfig());

    expect(result.success).toBe(true);
    expect(result.nextPhase).toBe("development");
    expect(mockedResearchStack).toHaveBeenCalledTimes(1);
    expect(mockedInstallLspServers).toHaveBeenCalledTimes(1);
    expect(mockedConfigureMcpServers).toHaveBeenCalledTimes(1);
    expect(mockedInstallPlugins).toHaveBeenCalledTimes(1);
    expect(mockedScanOpenSource).toHaveBeenCalledTimes(1);
    expect(mockedGenerateClaudeMd).toHaveBeenCalledTimes(1);
  });

  it("fails when architecture and spec are missing", async () => {
    const state = createInitialState("Build something");
    const result = await runEnvironmentSetup(state, makeConfig());

    expect(result.success).toBe(false);
    expect(result.error).toContain("Architecture and spec required");
  });

  it("fails when stack research (critical step) fails", async () => {
    mockedResearchStack.mockRejectedValue(new Error("Research API unavailable"));

    const state = makeStateWithArchitecture();
    const result = await runEnvironmentSetup(state, makeConfig());

    expect(result.success).toBe(false);
    expect(result.error).toContain("Stack research failed");
    // Non-critical steps should not be called
    expect(mockedInstallLspServers).not.toHaveBeenCalled();
    expect(mockedConfigureMcpServers).not.toHaveBeenCalled();
  });

  it("succeeds even when non-critical steps fail", async () => {
    mockedInstallLspServers.mockRejectedValue(new Error("LSP install failed"));
    mockedConfigureMcpServers.mockImplementation(() => {
      throw new Error("MCP config failed");
    });
    mockedInstallPlugins.mockRejectedValue(new Error("Plugin install failed"));

    const state = makeStateWithArchitecture();
    const result = await runEnvironmentSetup(state, makeConfig());

    // Non-critical failures should not prevent overall success
    expect(result.success).toBe(true);
    expect(result.nextPhase).toBe("development");
    expect(result.state.environment).toBeDefined();
  });
});
