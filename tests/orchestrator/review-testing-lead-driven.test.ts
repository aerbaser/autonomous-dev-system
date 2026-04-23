import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInitialState, type ProjectState } from "../../src/state/project-state.js";
import type { Config } from "../../src/utils/config.js";

const TEST_DIR = join(tmpdir(), `ads-test-review-testing-lead-${process.pid}`);

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

const { query: mockedQuery } = await import("@anthropic-ai/claude-agent-sdk");
const { runReview } = await import("../../src/phases/review.js");
const { runTesting } = await import("../../src/phases/testing.js");

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

function makeState(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    ...createInitialState("Test project"),
    currentPhase: "review",
    spec: {
      summary: "A todo app",
      userStories: [
        {
          id: "US-001",
          title: "Add todo",
          description: "As a user",
          acceptanceCriteria: ["given app, when submit, then todo appears"],
          priority: "must",
        },
      ],
      nonFunctionalRequirements: ["perf: p95 < 200ms"],
      domain: {
        classification: "web-application",
        specializations: [],
        requiredRoles: [],
        requiredMcpServers: [],
        techStack: ["typescript"],
      },
    },
    architecture: {
      techStack: { language: "TypeScript" },
      components: [{ name: "UI", description: "frontend", dependencies: [] }],
      apiContracts: "REST /todos",
      databaseSchema: "todos table",
      fileStructure: "src/",
    },
    ...overrides,
  };
}

function resultStream(payload: unknown, opts: { cost?: number; sessionId?: string } = {}) {
  return async function* () {
    yield {
      type: "result" as const,
      subtype: "success" as const,
      result: typeof payload === "string" ? payload : JSON.stringify(payload),
      session_id: opts.sessionId ?? "sid",
      total_cost_usd: opts.cost ?? 0.1,
      num_turns: 2,
    };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env["AUTONOMOUS_DEV_LEAD_DRIVEN"] = "1";
});

afterEach(() => {
  delete process.env["AUTONOMOUS_DEV_LEAD_DRIVEN"];
});

describe("review.ts — lead-driven", () => {
  it("routes approved verdict to staging", async () => {
    (mockedQuery as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      resultStream({ success: true, domain: { status: "approved" } }, { cost: 0.2 }),
    );
    const result = await runReview(makeState({ currentPhase: "review" }), makeConfig());
    expect(result.success).toBe(true);
    expect(result.nextPhase).toBe("staging");
  });

  it("routes requested_changes with explicit nextPhase=development", async () => {
    (mockedQuery as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      resultStream({
        success: true,
        nextPhase: "development",
        domain: { status: "requested_changes", summary: "security gaps" },
      }),
    );
    const result = await runReview(makeState({ currentPhase: "review" }), makeConfig());
    expect(result.success).toBe(true);
    expect(result.nextPhase).toBe("development");
  });

  it("rejects an illegal nextPhase from the lead", async () => {
    (mockedQuery as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      resultStream({
        success: true,
        nextPhase: "production",
        domain: { status: "approved" },
      }),
    );
    const result = await runReview(makeState({ currentPhase: "review" }), makeConfig());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/allowedNextPhases/);
  });

  it("falls back to single-query when env flag is off", async () => {
    delete process.env["AUTONOMOUS_DEV_LEAD_DRIVEN"];
    (mockedQuery as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      resultStream('APPROVE\n{"status":"approved"}'),
    );
    const result = await runReview(makeState({ currentPhase: "review" }), makeConfig());
    expect(result.success).toBe(true);
    expect(result.nextPhase).toBe("staging");
  });
});

describe("testing.ts — lead-driven", () => {
  it("routes passed verdict to review", async () => {
    (mockedQuery as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      resultStream({ success: true, domain: { status: "passed" } }),
    );
    const result = await runTesting(makeState({ currentPhase: "testing" }), makeConfig());
    expect(result.success).toBe(true);
    expect(result.nextPhase).toBe("review");
  });

  it("routes failed with explicit nextPhase=development", async () => {
    (mockedQuery as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      resultStream({
        success: true,
        nextPhase: "development",
        domain: { status: "failed", details: "3 tests failing" },
      }),
    );
    const result = await runTesting(makeState({ currentPhase: "testing" }), makeConfig());
    expect(result.success).toBe(true);
    expect(result.nextPhase).toBe("development");
  });

  it("falls back to single-query when env flag is off", async () => {
    delete process.env["AUTONOMOUS_DEV_LEAD_DRIVEN"];
    (mockedQuery as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      resultStream('PASS\n{"status":"passed"}'),
    );
    const result = await runTesting(makeState({ currentPhase: "testing" }), makeConfig());
    expect(result.success).toBe(true);
    expect(result.nextPhase).toBe("review");
  });
});
