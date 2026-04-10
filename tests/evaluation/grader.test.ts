import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Rubric } from "../../src/evaluation/rubric.js";
import type { PhaseResult } from "../../src/phases/types.js";
import { createInitialState } from "../../src/state/project-state.js";

// Mock the Agent SDK
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

const { query } = await import("@anthropic-ai/claude-agent-sdk");
const { gradePhaseOutput } = await import("../../src/evaluation/grader.js");

const mockedQuery = vi.mocked(query);

function makeConfig() {
  return {
    model: "claude-sonnet-4-6" as const,
    subagentModel: "claude-sonnet-4-6" as const,
    selfImprove: { enabled: false, maxIterations: 50, nightlyOptimize: false },
    projectDir: ".",
    stateDir: ".autonomous-dev",
    autonomousMode: true,
    rubrics: { enabled: true, maxIterations: 3 },
    memory: { enabled: false, maxDocuments: 500, maxDocumentSizeKb: 100 },
  };
}

const TEST_RUBRIC: Rubric = {
  name: "test-rubric",
  description: "Test rubric",
  criteria: [
    { name: "criterion_a", description: "A", weight: 0.6, threshold: 0.7 },
    { name: "criterion_b", description: "B", weight: 0.4, threshold: 0.5 },
  ],
};

function makeMockQueryStream(structuredOutput: unknown) {
  return (async function* () {
    yield {
      type: "result",
      subtype: "success",
      result: JSON.stringify(structuredOutput),
      session_id: "grader-session",
      total_cost_usd: 0.005,
      num_turns: 1,
      structured_output: structuredOutput,
    };
  })();
}

function makeMockQueryErrorStream(subtype: "error_max_turns" | "error_during_execution" = "error_max_turns") {
  return (async function* () {
    yield {
      type: "result",
      subtype,
      result: "",
      session_id: "grader-session",
      total_cost_usd: 0.002,
      num_turns: 0,
      errors: ["Reached maximum number of turns (1)"],
    };
  })();
}

describe("gradePhaseOutput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns structured RubricResult from grader output", async () => {
    const graderOutput = {
      scores: [
        { criterionName: "criterion_a", score: 0.9, passed: true, feedback: "Good" },
        { criterionName: "criterion_b", score: 0.8, passed: true, feedback: "Fine" },
      ],
      verdict: "satisfied",
      overallScore: 0.86,
      summary: "All criteria met",
    };

    mockedQuery.mockReturnValue(makeMockQueryStream(graderOutput) as any);

    const state = createInitialState("Test project");
    const phaseResult: PhaseResult = {
      success: true,
      state,
      nextPhase: "review",
    };

    const { rubricResult, costUsd } = await gradePhaseOutput(
      TEST_RUBRIC,
      phaseResult,
      state,
      { config: makeConfig() as any },
    );

    expect(rubricResult.rubricName).toBe("test-rubric");
    expect(rubricResult.scores).toHaveLength(2);
    expect(rubricResult.verdict).toBe("satisfied");
    expect(rubricResult.overallScore).toBeGreaterThan(0);
    expect(costUsd).toBe(0.005);
  });

  it("uses separate query context (not sharing conversation)", async () => {
    const graderOutput = {
      scores: [
        { criterionName: "criterion_a", score: 0.5, passed: false, feedback: "Below threshold" },
        { criterionName: "criterion_b", score: 0.6, passed: true, feedback: "OK" },
      ],
      verdict: "needs_revision",
      overallScore: 0.54,
      summary: "Needs work",
    };

    mockedQuery.mockReturnValue(makeMockQueryStream(graderOutput) as any);

    const state = createInitialState("Test project");
    const phaseResult: PhaseResult = { success: true, state };

    await gradePhaseOutput(TEST_RUBRIC, phaseResult, state, { config: makeConfig() as any });

    // Verify query was called with fresh prompt (no session_id — separate context)
    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const callArgs = mockedQuery.mock.calls[0]![0]!;
    expect(callArgs).toHaveProperty("prompt");
    // Should not have sessionId — it's a fresh context
    expect(callArgs).not.toHaveProperty("sessionId");
  });

  it("falls back gracefully when structured output parsing fails", async () => {
    // Return invalid structured output
    mockedQuery.mockReturnValue(
      (async function* () {
        yield {
          type: "result",
          subtype: "success",
          result: "This is not JSON at all",
          session_id: "grader-session",
          total_cost_usd: 0.003,
          num_turns: 1,
          structured_output: null,
        };
      })() as any
    );

    const state = createInitialState("Test project");
    const phaseResult: PhaseResult = { success: true, state };

    const { rubricResult } = await gradePhaseOutput(
      TEST_RUBRIC,
      phaseResult,
      state,
      { config: makeConfig() as any },
    );

    // Fallback: each criterion gets 0.5 score with passed=false
    expect(rubricResult.scores).toHaveLength(2);
    expect(rubricResult.scores[0]!.score).toBe(0.5);
    // All criteria fail in fallback, so verdict is "failed" (>50% failed)
    expect(rubricResult.verdict).toBe("failed");
  });

  it("trusts LLM-provided verdict and score when parsing succeeds", async () => {
    // LLM says "satisfied" — we trust it even if local recomputation would differ
    const graderOutput = {
      scores: [
        { criterionName: "criterion_a", score: 0.3, passed: false, feedback: "Bad" },
        { criterionName: "criterion_b", score: 0.2, passed: false, feedback: "Bad" },
      ],
      verdict: "satisfied",
      overallScore: 0.99,
      summary: "LLM judgment",
    };

    mockedQuery.mockReturnValue(makeMockQueryStream(graderOutput) as any);

    const state = createInitialState("Test project");
    const phaseResult: PhaseResult = { success: true, state };

    const { rubricResult } = await gradePhaseOutput(
      TEST_RUBRIC,
      phaseResult,
      state,
      { config: makeConfig() as any },
    );

    // LLM verdict is used as primary — not overwritten by local recomputation
    expect(rubricResult.verdict).toBe("satisfied");
    expect(rubricResult.overallScore).toBe(0.99);
  });

  it("uses custom graderModel when provided", async () => {
    const graderOutput = {
      scores: [
        { criterionName: "criterion_a", score: 0.9, passed: true, feedback: "Good" },
        { criterionName: "criterion_b", score: 0.8, passed: true, feedback: "Fine" },
      ],
      verdict: "satisfied",
      overallScore: 0.86,
      summary: "All good",
    };

    mockedQuery.mockReturnValue(makeMockQueryStream(graderOutput) as any);

    const state = createInitialState("Test project");
    const phaseResult: PhaseResult = { success: true, state };

    await gradePhaseOutput(
      TEST_RUBRIC,
      phaseResult,
      state,
      { model: "claude-haiku-4-5-20251001", config: makeConfig() as any },
    );

    const callArgs = mockedQuery.mock.calls[0]![0]! as Record<string, unknown>;
    const options = callArgs.options as Record<string, unknown>;
    expect(options.model).toBe("claude-haiku-4-5-20251001");
  });

  it("fails open when grader query errors", async () => {
    mockedQuery.mockReturnValue(makeMockQueryErrorStream() as any);

    const state = createInitialState("Test project");
    const phaseResult: PhaseResult = { success: true, state };

    const { rubricResult, costUsd } = await gradePhaseOutput(
      TEST_RUBRIC,
      phaseResult,
      state,
      { config: makeConfig() as any },
    );

    expect(rubricResult.verdict).toBe("satisfied");
    expect(rubricResult.summary).toContain("Grader unavailable");
    expect(rubricResult.scores.every((score) => score.passed)).toBe(true);
    expect(costUsd).toBe(0);
  });
});
