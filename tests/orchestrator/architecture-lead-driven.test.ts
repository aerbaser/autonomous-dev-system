import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInitialState, type ProjectState } from "../../src/state/project-state.js";
import type { Config } from "../../src/utils/config.js";

const TEST_DIR = join(tmpdir(), `ads-test-arch-lead-${process.pid}`);

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));
vi.mock("../../src/agents/factory.js", () => ({
  buildAgentTeam: vi.fn(),
}));

const { query: mockedQuery } = await import("@anthropic-ai/claude-agent-sdk");
const { buildAgentTeam } = await import("../../src/agents/factory.js");
const { runArchitecture } = await import("../../src/phases/architecture.js");

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    model: "claude-opus-4-6",
    subagentModel: "claude-sonnet-4-6",
    selfImprove: { enabled: false, maxIterations: 50, nightlyOptimize: false },
    projectDir: TEST_DIR,
    stateDir: join(TEST_DIR, ".autonomous-dev"),
    memory: { enabled: false, maxDocuments: 500, maxDocumentSizeKb: 100, layers: { enabled: false } },
    rubrics: { enabled: false, maxIterations: 3 },
    ...overrides,
  } as Config;
}

function makeSpecState(): ProjectState {
  return {
    ...createInitialState("Build a todo app"),
    currentPhase: "architecture",
    spec: {
      summary: "A simple todo app",
      userStories: [
        {
          id: "US-001",
          title: "Add todo",
          description: "As a user, I want to add todos",
          acceptanceCriteria: ["Given app, when submit, then todo appears"],
          priority: "must",
        },
      ],
      nonFunctionalRequirements: ["p95 < 200ms"],
      domain: {
        classification: "web-application",
        specializations: [],
        requiredRoles: [],
        requiredMcpServers: [],
        techStack: ["typescript", "react"],
      },
    },
  };
}

const VALID_ARCH_DOMAIN = {
  techStack: { language: "TypeScript 5.6" },
  components: [{ name: "Frontend", description: "Next.js UI", dependencies: [] }],
  apiContracts: "REST endpoints for /todos CRUD",
  databaseSchema: "Table todos (id, title, done)",
  fileStructure: "src/\n  app/\n    page.tsx",
  taskDecomposition: {
    tasks: [
      {
        id: "T-001",
        title: "Scaffold project",
        description: "Set up Next.js + vitest",
        estimatedComplexity: "low",
        dependencies: [],
        acceptanceCriteria: ["scaffold runs", "tests pass", "lint clean"],
      },
    ],
  },
};

async function* streamArchLeadResult(
  domain: unknown,
  opts: { cost?: number; sessionId?: string } = {},
) {
  yield {
    type: "result" as const,
    subtype: "success" as const,
    result: JSON.stringify({ success: true, domain }),
    session_id: opts.sessionId ?? "session-arch",
    total_cost_usd: opts.cost ?? 0.33,
    num_turns: 5,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  // buildAgentTeam is mocked to return a minimal registry with enough
  // shape for runLeadDrivenPhase → buildSpecialists to resolve the two
  // specialists the contract requires.
  (buildAgentTeam as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    registry: {
      toAgentDefinition: (name: string) => ({
        description: `mock ${name}`,
        prompt: `mock prompt for ${name}`,
        tools: ["Read", "Grep", "Glob"],
      }),
      getAll: () => [],
    },
  });
  process.env["AUTONOMOUS_DEV_LEAD_DRIVEN"] = "1";
});

afterEach(() => {
  delete process.env["AUTONOMOUS_DEV_LEAD_DRIVEN"];
});

describe("architecture.ts — lead-driven path", () => {
  it("runs through runLeadDrivenPhase and returns a valid ArchDesign", async () => {
    (mockedQuery as unknown as ReturnType<typeof vi.fn>).mockImplementation(() =>
      streamArchLeadResult(VALID_ARCH_DOMAIN, { cost: 0.25, sessionId: "s1" }),
    );

    const state = makeSpecState();
    const result = await runArchitecture(state, makeConfig());

    expect(result.success).toBe(true);
    expect(result.costUsd).toBe(0.25);
    expect(result.sessionId).toBe("s1");
    expect(result.state.architecture?.techStack.language).toBe("TypeScript 5.6");
    expect(result.state.architecture?.components.length).toBeGreaterThan(0);
    expect(result.state.architecture?.taskDecomposition?.tasks[0]?.id).toBe("T-001");
  });

  it("propagates a lead-requested legal backloop nextPhase", async () => {
    (mockedQuery as unknown as ReturnType<typeof vi.fn>).mockImplementation(() =>
      streamArchLeadResult({ ...VALID_ARCH_DOMAIN }),
    );
    // Stream result with nextPhase: "development" (legal per contract)
    (mockedQuery as unknown as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      yield {
        type: "result" as const,
        subtype: "success" as const,
        result: JSON.stringify({
          success: true,
          nextPhase: "development",
          domain: VALID_ARCH_DOMAIN,
        }),
        session_id: "s2",
        total_cost_usd: 0.1,
        num_turns: 2,
      };
    });

    const result = await runArchitecture(makeSpecState(), makeConfig());
    expect(result.success).toBe(true);
    expect(result.nextPhase).toBe("development");
  });

  it("returns failure when lead emits an illegal nextPhase", async () => {
    (mockedQuery as unknown as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      yield {
        type: "result" as const,
        subtype: "success" as const,
        result: JSON.stringify({
          success: true,
          nextPhase: "production",
          domain: VALID_ARCH_DOMAIN,
        }),
        session_id: "s3",
        total_cost_usd: 0.05,
        num_turns: 2,
      };
    });

    const result = await runArchitecture(makeSpecState(), makeConfig());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/allowedNextPhases/);
  });

  it("returns failure when lead emits malformed JSON", async () => {
    (mockedQuery as unknown as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      yield {
        type: "result" as const,
        subtype: "success" as const,
        result: "no JSON here, just prose",
        session_id: "s4",
        total_cost_usd: 0.01,
        num_turns: 1,
      };
    });

    const result = await runArchitecture(makeSpecState(), makeConfig());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/JSON/);
  });

  it("falls back to single-query path when the env var is not set", async () => {
    delete process.env["AUTONOMOUS_DEV_LEAD_DRIVEN"];
    // Return a valid ArchDesign JSON on the non-lead path too.
    (mockedQuery as unknown as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      yield {
        type: "result" as const,
        subtype: "success" as const,
        result: JSON.stringify(VALID_ARCH_DOMAIN),
        session_id: "s5",
        total_cost_usd: 0.08,
        num_turns: 2,
      };
    });

    const result = await runArchitecture(makeSpecState(), makeConfig());
    expect(result.success).toBe(true);
    // Non-lead path returns nextPhase=environment-setup deterministically.
    expect(result.nextPhase).toBe("environment-setup");
  });
});
