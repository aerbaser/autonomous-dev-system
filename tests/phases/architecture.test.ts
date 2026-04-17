import { describe, it, expect, vi, beforeEach } from "vitest";
import { createInitialState } from "../../src/state/project-state.js";
import type { Config } from "../../src/utils/config.js";
import type { ProjectState } from "../../src/state/project-state.js";

// Mock the Agent SDK
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

// Mock buildAgentTeam to avoid real SDK calls
vi.mock("../../src/agents/factory.js", () => ({
  buildAgentTeam: vi.fn(),
}));

const { query } = await import("@anthropic-ai/claude-agent-sdk");
const { buildAgentTeam } = await import("../../src/agents/factory.js");
const { runArchitecture } = await import("../../src/phases/architecture.js");

const mockedQuery = vi.mocked(query);
const mockedBuildAgentTeam = vi.mocked(buildAgentTeam);

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

function makeStateWithSpec(): ProjectState {
  const state = createInitialState("Build a task management app");
  return {
    ...state,
    spec: {
      summary: "A task management app",
      userStories: [
        {
          id: "US-001",
          title: "Create task",
          description: "As a user, I want to create tasks",
          acceptanceCriteria: ["Given the app, when I submit, then a task is created"],
          priority: "must",
        },
      ],
      nonFunctionalRequirements: ["Performance: fast"],
      domain: {
        classification: "productivity",
        specializations: ["task management"],
        requiredRoles: [],
        requiredMcpServers: ["playwright"],
        techStack: ["typescript", "react"],
      },
    },
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

describe("Architecture Phase", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock for buildAgentTeam
    mockedBuildAgentTeam.mockResolvedValue({
      registry: { getAll: () => [] } as any,
      domain: null,
    });
  });

  it("produces ArchDesign with techStack from valid JSON response", async () => {
    const archJson = JSON.stringify({
      techStack: {
        language: "TypeScript",
        framework: "Next.js 15",
        database: "PostgreSQL",
        orm: "Prisma",
      },
      components: [
        { name: "Web frontend", description: "Next.js app router", dependencies: [] },
        { name: "API server", description: "Route handlers with Zod validation", dependencies: ["Web frontend"] },
        { name: "Database layer", description: "Prisma ORM + PostgreSQL", dependencies: ["API server"] },
      ],
      apiContracts: "REST API with OpenAPI spec",
      databaseSchema: "CREATE TABLE tasks (...)",
      fileStructure: "src/\n  app/\n  lib/\n  prisma/",
    });

    mockedQuery.mockReturnValue(makeMockQueryIterator(archJson) as any);

    const state = makeStateWithSpec();
    const result = await runArchitecture(state, makeConfig());

    expect(result.success).toBe(true);
    expect(result.nextPhase).toBe("environment-setup");
    expect(result.state.architecture).toBeDefined();
    expect(result.state.architecture!.techStack).toBeDefined();
    expect(Object.keys(result.state.architecture!.techStack).length).toBeGreaterThanOrEqual(2);
    expect(result.state.architecture!.techStack.language).toBe("TypeScript");
    expect(result.state.architecture!.components.length).toBeGreaterThan(0);
  });

  it("returns failure when no spec is available", async () => {
    const state = createInitialState("Build something");
    const result = await runArchitecture(state, makeConfig());

    expect(result.success).toBe(false);
    expect(result.error).toContain("No spec found");
  });

  it("returns failure when query returns no JSON", async () => {
    mockedQuery.mockReturnValue(
      makeMockQueryIterator("I cannot generate an architecture for this.") as any
    );

    const state = makeStateWithSpec();
    const result = await runArchitecture(state, makeConfig());

    expect(result.success).toBe(false);
    expect(result.error).toContain("no valid JSON");
  });

  it("returns failure when query returns invalid JSON", async () => {
    mockedQuery.mockReturnValue(
      makeMockQueryIterator("{ invalid json object }") as any
    );

    const state = makeStateWithSpec();
    const result = await runArchitecture(state, makeConfig());

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid architecture JSON");
  });

  it("normalizes object-shaped contract fields into strings", async () => {
    const archJson = JSON.stringify({
      techStack: {
        language: "TypeScript",
        framework: "Next.js 15",
      },
      components: [
        { name: "API server", description: "Handles app requests", dependencies: [] },
      ],
      apiContracts: {
        format: "OpenAPI 3.1",
        endpoints: ["/alerts", "/symbols"],
      },
      databaseSchema: {
        tables: ["alerts", "symbols"],
        indexes: ["idx_alerts_symbol"],
      },
      fileStructure: {
        root: "src/",
        api: "src/app/api",
      },
    });

    mockedQuery.mockReturnValue(makeMockQueryIterator(archJson) as any);

    const state = makeStateWithSpec();
    const result = await runArchitecture(state, makeConfig());

    expect(result.success).toBe(true);
    expect(result.state.architecture?.apiContracts).toContain("OpenAPI 3.1");
    expect(result.state.architecture?.databaseSchema).toContain("alerts");
    expect(result.state.architecture?.fileStructure).toContain("src/");
  });

  it("repairs a schema-invalid architecture response before failing the phase", async () => {
    const invalidArchJson = JSON.stringify({
      techStack: {
        language: "TypeScript",
        framework: "Next.js 15",
      },
      components: [
        { name: "API server", description: "Handles alert API requests", dependencies: [] },
      ],
      apiContracts: "REST API with alert endpoints",
      databaseSchema: "CREATE TABLE alerts (...);",
    });

    const repairedArchJson = JSON.stringify({
      techStack: {
        language: "TypeScript",
        framework: "Next.js 15",
      },
      components: [
        { name: "API server", description: "Handles alert API requests", dependencies: [] },
      ],
      apiContracts: "REST API with alert endpoints",
      databaseSchema: "CREATE TABLE alerts (...);",
      fileStructure: "src/",
    });

    mockedQuery
      .mockReturnValueOnce(makeMockQueryIterator(invalidArchJson) as any)
      .mockReturnValueOnce(makeMockQueryIterator(repairedArchJson) as any);

    const state = makeStateWithSpec();
    const result = await runArchitecture(state, makeConfig());

    expect(result.success).toBe(true);
    expect(mockedQuery).toHaveBeenCalledTimes(2);
    expect(result.state.architecture?.components[0]?.description).toContain("alert API");
  });

  it("returns failure when the parsed architecture is incomplete", async () => {
    const archJson = JSON.stringify({
      techStack: {
        language: "TypeScript",
      },
      components: [],
      apiContracts: "",
      databaseSchema: "",
      fileStructure: "",
    });

    mockedQuery.mockReturnValue(makeMockQueryIterator(archJson) as any);

    const state = makeStateWithSpec();
    const result = await runArchitecture(state, makeConfig());

    expect(result.success).toBe(false);
    expect(result.error).toContain("Architecture incomplete");
  });
});
