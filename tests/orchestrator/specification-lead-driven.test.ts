import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInitialState, type ProjectState } from "../../src/state/project-state.js";
import type { Config } from "../../src/utils/config.js";

const TEST_DIR = join(tmpdir(), `ads-test-spec-lead-${process.pid}`);

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

const { query: mockedQuery } = await import("@anthropic-ai/claude-agent-sdk");
const { runSpecification } = await import("../../src/phases/specification.js");

function makeConfig(): Config {
  return {
    model: "claude-opus-4-6",
    subagentModel: "claude-sonnet-4-6",
    selfImprove: { enabled: false, maxIterations: 50, nightlyOptimize: false },
    projectDir: TEST_DIR,
    stateDir: join(TEST_DIR, ".autonomous-dev"),
    memory: { enabled: false, maxDocuments: 500, maxDocumentSizeKb: 100, layers: { enabled: false } },
    rubrics: { enabled: false, maxIterations: 3 },
  } as Config;
}

function makeState(): ProjectState {
  return {
    ...createInitialState("Build a todo app"),
    currentPhase: "specification",
    spec: {
      summary: "simple todo",
      userStories: [
        {
          id: "US-001",
          title: "Add todo",
          description: "As a user",
          acceptanceCriteria: ["coarse AC"],
          priority: "must",
        },
      ],
      nonFunctionalRequirements: ["fast"],
      domain: {
        classification: "web-application",
        specializations: [],
        requiredRoles: [],
        requiredMcpServers: [],
        techStack: ["typescript"],
      },
    },
  };
}

const VALID_DETAILED_DOMAIN = {
  refinedUserStories: [
    {
      id: "US-001",
      title: "Add todo",
      acceptanceCriteria: [
        "Given the app is running, when the user types a title and clicks Add, then a new row appears",
        "Given an empty title, when the user clicks Add, then the form shows a required-field error",
      ],
    },
  ],
  refinedNonFunctionalRequirements: [
    { category: "performance", requirement: "Render p95", threshold: "<200ms at 100 RPS" },
  ],
  outOfScope: ["multi-user sync"],
  integrationBoundaries: [{ name: "none", description: "self-contained single-user app" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env["AUTONOMOUS_DEV_LEAD_DRIVEN"] = "1";
});

afterEach(() => {
  delete process.env["AUTONOMOUS_DEV_LEAD_DRIVEN"];
});

describe("specification.ts — lead-driven", () => {
  it("routes through runLeadDrivenPhase and applies DetailedSpec to state.spec.detailed", async () => {
    (mockedQuery as unknown as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      yield {
        type: "result" as const,
        subtype: "success" as const,
        result: JSON.stringify({ success: true, domain: VALID_DETAILED_DOMAIN }),
        session_id: "spec-sid",
        total_cost_usd: 0.15,
        num_turns: 4,
      };
    });

    const result = await runSpecification(makeState(), makeConfig());
    expect(result.success).toBe(true);
    expect(result.costUsd).toBe(0.15);
    expect(result.state.spec?.detailed?.refinedUserStories.length).toBe(1);
    expect(result.state.spec?.detailed?.refinedNonFunctionalRequirements[0]?.threshold).toContain("<200ms");
  });

  it("falls back to single-query when env flag is off", async () => {
    delete process.env["AUTONOMOUS_DEV_LEAD_DRIVEN"];
    (mockedQuery as unknown as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      yield {
        type: "result" as const,
        subtype: "success" as const,
        result: JSON.stringify(VALID_DETAILED_DOMAIN),
        session_id: "non-lead-sid",
        total_cost_usd: 0.08,
        num_turns: 2,
      };
    });

    const result = await runSpecification(makeState(), makeConfig());
    expect(result.success).toBe(true);
    expect(result.nextPhase).toBe("architecture");
  });

  it("rejects a domain that fails DetailedSpecSchema", async () => {
    (mockedQuery as unknown as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      yield {
        type: "result" as const,
        subtype: "success" as const,
        result: JSON.stringify({ success: true, domain: { refinedUserStories: "not an array" } }),
        session_id: "x",
        total_cost_usd: 0.01,
        num_turns: 1,
      };
    });

    const result = await runSpecification(makeState(), makeConfig());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/schema validation/);
  });
});
