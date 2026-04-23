import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { PhaseContract } from "../../src/orchestrator/phase-contract.js";
import type { ProjectState } from "../../src/state/project-state.js";
import type { Config } from "../../src/utils/config.js";
import { createInitialState } from "../../src/state/project-state.js";

const TEST_DIR = join(tmpdir(), `ads-test-lead-driven-${process.pid}`);

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

const { query: mockedQuery } = await import("@anthropic-ai/claude-agent-sdk");
const { runLeadDrivenPhase, sanitizeSpecialistTools, buildSpecialists, parseLeadEnvelope, buildLeadPrompt, PhaseBudgetGuard } =
  await import("../../src/orchestrator/lead-driven-phase.js");

const SuccessDomainSchema = z.object({
  summary: z.string(),
  findings: z.array(z.string()),
});
type SuccessDomain = z.infer<typeof SuccessDomainSchema>;

function makeContract(
  overrides: Partial<PhaseContract<SuccessDomain>> = {},
): PhaseContract<SuccessDomain> {
  return {
    phase: "architecture",
    goals: "Design the system.",
    deliverables: ["architecture blueprint"],
    allowedNextPhases: ["environment-setup", "development"],
    outputSchema: SuccessDomainSchema,
    specialistNames: [],
    contextSelector: () => ({ summary: ["test"], slices: {} }),
    ...overrides,
  };
}

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

function makeState(): ProjectState {
  return {
    ...createInitialState("build a thing"),
    currentPhase: "architecture",
  };
}

interface FakeRegistry {
  toAgentDefinition: (name: string) => AgentDefinition;
}

function makeRegistry(
  defs: Record<string, AgentDefinition>,
): FakeRegistry {
  return {
    toAgentDefinition: (name: string) => {
      const def = defs[name];
      if (!def) throw new Error(`Agent not found: ${name}`);
      return def;
    },
  };
}

async function* streamFinalResult(resultText: string, opts: { cost?: number; sessionId?: string } = {}) {
  yield {
    type: "result" as const,
    subtype: "success" as const,
    result: resultText,
    session_id: opts.sessionId ?? "session-1",
    total_cost_usd: opts.cost ?? 0.05,
    num_turns: 3,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

describe("sanitizeSpecialistTools", () => {
  it("strips the Agent tool to prevent recursive coordination", () => {
    expect(sanitizeSpecialistTools(["Read", "Write", "Agent", "Bash"])).toEqual([
      "Read",
      "Write",
      "Bash",
    ]);
  });

  it("leaves allowed tool lists unchanged", () => {
    expect(sanitizeSpecialistTools(["Read", "Glob"])).toEqual(["Read", "Glob"]);
  });

  it("returns an empty array when only denied tools are present", () => {
    expect(sanitizeSpecialistTools(["Agent"])).toEqual([]);
  });
});

describe("buildSpecialists", () => {
  it("sanitizes each specialist's tools and stamps subagentModel", () => {
    const registry = makeRegistry({
      "security-reviewer": {
        description: "sec",
        prompt: "you review security",
        tools: ["Read", "Agent", "Grep"],
      },
    });
    const specialists = buildSpecialists(
      makeContract({ specialistNames: ["security-reviewer"] }),
      makeConfig(),
      registry as never,
    );
    expect(specialists["security-reviewer"]?.tools).toEqual(["Read", "Grep"]);
    expect(specialists["security-reviewer"]?.model).toBe("claude-sonnet-4-6");
  });
});

describe("buildLeadPrompt", () => {
  it("includes goals, deliverables, specialists, allowed backloops, and output schema", () => {
    const { systemPrompt, userPrompt } = buildLeadPrompt(
      makeContract({
        goals: "design thing",
        deliverables: ["blueprint", "DAG"],
        specialistNames: ["security-reviewer"],
        allowedNextPhases: ["development"],
      }),
      makeState(),
    );
    expect(systemPrompt).toContain("design thing");
    expect(systemPrompt).toContain("- blueprint");
    expect(systemPrompt).toContain("- DAG");
    expect(systemPrompt).toContain("security-reviewer");
    expect(systemPrompt).toContain("development");
    expect(systemPrompt).toMatch(/Output contract/);
    expect(userPrompt).toContain("<phase-context>");
  });

  it("says nextPhase is not allowed when allowedNextPhases is empty", () => {
    const { systemPrompt } = buildLeadPrompt(
      makeContract({ allowedNextPhases: [] }),
      makeState(),
    );
    expect(systemPrompt).toMatch(/cannot transition/i);
  });

  it("tells the lead nextPhase is auto-filled when there is exactly 1 legal target", () => {
    const { systemPrompt } = buildLeadPrompt(
      makeContract({ allowedNextPhases: ["development"] }),
      makeState(),
    );
    expect(systemPrompt).toMatch(/MAY omit `nextPhase`/);
    expect(systemPrompt).toContain("development");
  });

  it("requires nextPhase when multiple legal targets exist", () => {
    const { systemPrompt } = buildLeadPrompt(
      makeContract({ allowedNextPhases: ["development", "environment-setup"] }),
      makeState(),
    );
    expect(systemPrompt).toMatch(/MUST set `nextPhase`/);
  });
});

describe("parseLeadEnvelope", () => {
  it("rejects non-JSON output", () => {
    const result = parseLeadEnvelope(makeContract(), "the lead babbled without JSON");
    expect(result.error).toMatch(/no parseable JSON/);
  });

  it("rejects a nextPhase outside allowedNextPhases", () => {
    const json = JSON.stringify({
      success: true,
      nextPhase: "production",
      domain: { summary: "x", findings: [] },
    });
    const result = parseLeadEnvelope(makeContract(), json);
    expect(result.error).toMatch(/allowedNextPhases/);
  });

  it("accepts a legal nextPhase", () => {
    const json = JSON.stringify({
      success: true,
      nextPhase: "development",
      domain: { summary: "x", findings: [] },
    });
    const result = parseLeadEnvelope(makeContract(), json);
    expect(result.error).toBeUndefined();
    expect(result.envelope.nextPhase).toBe("development");
  });

  it("rejects a domain payload that fails Zod validation", () => {
    const json = JSON.stringify({
      success: true,
      domain: { summary: 123, findings: "not an array" },
    });
    const result = parseLeadEnvelope(makeContract(), json);
    expect(result.error).toMatch(/schema validation/);
  });

  it("returns the validated domain on success", () => {
    const json = JSON.stringify({
      success: true,
      domain: { summary: "all good", findings: ["a", "b"] },
    });
    const result = parseLeadEnvelope(makeContract(), json);
    expect(result.error).toBeUndefined();
    expect(result.domain).toEqual({ summary: "all good", findings: ["a", "b"] });
  });

  it("passes through success=false without enforcing domain", () => {
    const json = JSON.stringify({
      success: false,
      error: "lead gave up",
    });
    const result = parseLeadEnvelope(makeContract(), json);
    expect(result.error).toBeUndefined();
    expect(result.envelope.success).toBe(false);
    expect(result.envelope.error).toBe("lead gave up");
  });
});

describe("PhaseBudgetGuard", () => {
  it("aborts its own signal when cost exceeds the cap", () => {
    const guard = new PhaseBudgetGuard(0.1);
    expect(guard.signal.aborted).toBe(false);
    guard.updateCost(0.2);
    expect(guard.signal.aborted).toBe(true);
    expect(guard.isBudgetExceeded()).toBe(true);
    guard.dispose();
  });

  it("does not cross-fire: phase abort does NOT abort the run signal", () => {
    const runController = new AbortController();
    const guard = new PhaseBudgetGuard(0.1, runController.signal);
    guard.updateCost(0.5);
    expect(guard.signal.aborted).toBe(true);
    expect(runController.signal.aborted).toBe(false);
    guard.dispose();
  });

  it("run abort propagates into the composed signal", () => {
    const runController = new AbortController();
    const guard = new PhaseBudgetGuard(1.0, runController.signal);
    expect(guard.signal.aborted).toBe(false);
    runController.abort("SIGINT");
    expect(guard.signal.aborted).toBe(true);
    expect(guard.isBudgetExceeded()).toBe(false);
    guard.dispose();
  });
});

describe("runLeadDrivenPhase", () => {
  it("applies domain result on success and returns cost + sessionId", async () => {
    (mockedQuery as unknown as ReturnType<typeof vi.fn>).mockImplementation(() =>
      streamFinalResult(
        JSON.stringify({
          success: true,
          domain: { summary: "ok", findings: ["f1"] },
        }),
        { cost: 0.42, sessionId: "session-42" },
      ),
    );

    const registry = makeRegistry({});
    const result = await runLeadDrivenPhase({
      contract: makeContract(),
      state: makeState(),
      config: makeConfig(),
      registry: registry as never,
      applyResult: (state, domain) => ({
        ...state,
        architecture: {
          techStack: { summary: domain.summary },
          components: [],
          apiContracts: "",
          databaseSchema: "",
          fileStructure: "",
        } as never,
      }),
    });

    expect(result.success).toBe(true);
    expect(result.costUsd).toBe(0.42);
    expect(result.sessionId).toBe("session-42");
    expect((result.state.architecture as { techStack: { summary: string } } | null)?.techStack.summary).toBe("ok");
  });

  it("returns a failure PhaseResult when lead emits an illegal nextPhase", async () => {
    (mockedQuery as unknown as ReturnType<typeof vi.fn>).mockImplementation(() =>
      streamFinalResult(
        JSON.stringify({
          success: true,
          nextPhase: "production",
          domain: { summary: "ok", findings: [] },
        }),
      ),
    );

    const result = await runLeadDrivenPhase({
      contract: makeContract(),
      state: makeState(),
      config: makeConfig(),
      registry: makeRegistry({}) as never,
      applyResult: (s) => s,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/allowedNextPhases/);
  });

  it("propagates a legal backloop nextPhase on success", async () => {
    (mockedQuery as unknown as ReturnType<typeof vi.fn>).mockImplementation(() =>
      streamFinalResult(
        JSON.stringify({
          success: true,
          nextPhase: "development",
          domain: { summary: "ok", findings: [] },
        }),
      ),
    );

    const result = await runLeadDrivenPhase({
      contract: makeContract(),
      state: makeState(),
      config: makeConfig(),
      registry: makeRegistry({}) as never,
      applyResult: (s) => s,
    });
    expect(result.success).toBe(true);
    expect(result.nextPhase).toBe("development");
  });

  it("returns a failure PhaseResult when the lead emits malformed JSON", async () => {
    (mockedQuery as unknown as ReturnType<typeof vi.fn>).mockImplementation(() =>
      streamFinalResult("completely non-JSON babble"),
    );

    const result = await runLeadDrivenPhase({
      contract: makeContract(),
      state: makeState(),
      config: makeConfig(),
      registry: makeRegistry({}) as never,
      applyResult: (s) => s,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/JSON/);
  });

  it("honors SIGINT propagated through execCtx.signal", async () => {
    const controller = new AbortController();
    controller.abort("SIGINT");

    (mockedQuery as unknown as ReturnType<typeof vi.fn>).mockImplementation(() =>
      streamFinalResult(JSON.stringify({ success: true, domain: { summary: "x", findings: [] } })),
    );

    const result = await runLeadDrivenPhase({
      contract: makeContract(),
      state: makeState(),
      config: makeConfig(),
      execCtx: { signal: controller.signal },
      registry: makeRegistry({}) as never,
      applyResult: (s) => s,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/aborted/i);
  });

  it("auto-fills nextPhase when contract has exactly 1 legal target and lead omits it", async () => {
    (mockedQuery as unknown as ReturnType<typeof vi.fn>).mockImplementation(() =>
      streamFinalResult(
        JSON.stringify({
          success: true,
          domain: { summary: "ok", findings: [] },
        }),
        { sessionId: "auto-fill" },
      ),
    );

    const result = await runLeadDrivenPhase({
      contract: makeContract({ allowedNextPhases: ["environment-setup"] }),
      state: makeState(),
      config: makeConfig(),
      registry: makeRegistry({}) as never,
      applyResult: (s) => s,
    });

    expect(result.success).toBe(true);
    expect(result.nextPhase).toBe("environment-setup");
  });

  it("does NOT auto-fill nextPhase when contract has multiple legal targets", async () => {
    (mockedQuery as unknown as ReturnType<typeof vi.fn>).mockImplementation(() =>
      streamFinalResult(
        JSON.stringify({
          success: true,
          domain: { summary: "ok", findings: [] },
        }),
        { sessionId: "no-autofill" },
      ),
    );

    const result = await runLeadDrivenPhase({
      contract: makeContract({ allowedNextPhases: ["environment-setup", "development"] }),
      state: makeState(),
      config: makeConfig(),
      registry: makeRegistry({}) as never,
      applyResult: (s) => s,
    });

    expect(result.success).toBe(true);
    expect(result.nextPhase).toBeUndefined();
  });
});
