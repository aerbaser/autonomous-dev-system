import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PhaseResult } from "../../src/phases/types.js";
import type { Rubric, RubricResult } from "../../src/evaluation/rubric.js";
import { createInitialState } from "../../src/state/project-state.js";
import { EventBus } from "../../src/events/event-bus.js";

// Mock grader
vi.mock("../../src/evaluation/grader.js", () => ({
  gradePhaseOutput: vi.fn(),
}));

const { gradePhaseOutput } = await import("../../src/evaluation/grader.js");
const { evaluateWithRubric } = await import("../../src/evaluation/evaluate-loop.js");

const mockedGradePhaseOutput = vi.mocked(gradePhaseOutput);

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
    { name: "a", description: "A", weight: 0.5, threshold: 0.7 },
    { name: "b", description: "B", weight: 0.5, threshold: 0.7 },
  ],
};

function makeRubricResult(
  verdict: RubricResult["verdict"],
  overallScore: number,
  iteration = 1,
): RubricResult {
  return {
    rubricName: "test-rubric",
    scores: [
      { criterionName: "a", score: overallScore, passed: verdict === "satisfied", feedback: "test" },
      { criterionName: "b", score: overallScore, passed: verdict === "satisfied", feedback: "test" },
    ],
    verdict,
    overallScore,
    summary: `Verdict: ${verdict}`,
    iteration,
  };
}

describe("evaluateWithRubric", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns on first iteration when satisfied", async () => {
    const state = createInitialState("Test");
    const handler = vi.fn<() => Promise<PhaseResult>>().mockResolvedValue({
      success: true,
      state,
      nextPhase: "review",
      costUsd: 0.01,
    });

    mockedGradePhaseOutput.mockResolvedValue({
      rubricResult: makeRubricResult("satisfied", 0.9),
      costUsd: 0.005,
    });

    const result = await evaluateWithRubric(
      handler,
      makeConfig() as any,
      TEST_RUBRIC,
      3,
    );

    expect(result.success).toBe(true);
    expect(result.rubricResult.verdict).toBe("satisfied");
    expect(result.totalIterations).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(mockedGradePhaseOutput).toHaveBeenCalledTimes(1);
  });

  it("iterates when needs_revision and stops when satisfied", async () => {
    const state = createInitialState("Test");
    const handler = vi.fn<() => Promise<PhaseResult>>().mockResolvedValue({
      success: true,
      state,
      costUsd: 0.01,
    });

    let callCount = 0;
    mockedGradePhaseOutput.mockImplementation(async () => {
      callCount++;
      if (callCount < 2) {
        return { rubricResult: makeRubricResult("needs_revision", 0.5), costUsd: 0.005 };
      }
      return { rubricResult: makeRubricResult("satisfied", 0.9), costUsd: 0.005 };
    });

    const result = await evaluateWithRubric(
      handler,
      makeConfig() as any,
      TEST_RUBRIC,
      3,
    );

    expect(result.rubricResult.verdict).toBe("satisfied");
    expect(result.totalIterations).toBe(2);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("stops immediately on 'failed' verdict", async () => {
    const state = createInitialState("Test");
    const handler = vi.fn<() => Promise<PhaseResult>>().mockResolvedValue({
      success: true,
      state,
      costUsd: 0.01,
    });

    mockedGradePhaseOutput.mockResolvedValue({
      rubricResult: makeRubricResult("failed", 0.2),
      costUsd: 0.005,
    });

    const result = await evaluateWithRubric(
      handler,
      makeConfig() as any,
      TEST_RUBRIC,
      3,
    );

    expect(result.rubricResult.verdict).toBe("failed");
    expect(result.totalIterations).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("respects maxIterations limit", async () => {
    const state = createInitialState("Test");
    const handler = vi.fn<() => Promise<PhaseResult>>().mockResolvedValue({
      success: true,
      state,
      costUsd: 0.01,
    });

    mockedGradePhaseOutput.mockResolvedValue({
      rubricResult: makeRubricResult("needs_revision", 0.5),
      costUsd: 0.005,
    });

    const result = await evaluateWithRubric(
      handler,
      makeConfig() as any,
      TEST_RUBRIC,
      2,
    );

    expect(result.totalIterations).toBe(2);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(mockedGradePhaseOutput).toHaveBeenCalledTimes(2);
  });

  it("returns immediately when phase handler fails", async () => {
    const state = createInitialState("Test");
    const handler = vi.fn<() => Promise<PhaseResult>>().mockResolvedValue({
      success: false,
      state,
      error: "Compilation failed",
    });

    const result = await evaluateWithRubric(
      handler,
      makeConfig() as any,
      TEST_RUBRIC,
      3,
    );

    expect(result.success).toBe(false);
    expect(result.rubricResult.verdict).toBe("failed");
    expect(result.rubricResult.summary).toContain("Compilation failed");
    expect(result.totalIterations).toBe(1);
    expect(mockedGradePhaseOutput).not.toHaveBeenCalled();
  });

  it("accumulates cost across iterations", async () => {
    const state = createInitialState("Test");
    const handler = vi.fn<() => Promise<PhaseResult>>().mockResolvedValue({
      success: true,
      state,
      costUsd: 0.10,
    });

    let callCount = 0;
    mockedGradePhaseOutput.mockImplementation(async () => {
      callCount++;
      if (callCount < 3) {
        return { rubricResult: makeRubricResult("needs_revision", 0.5), costUsd: 0.05 };
      }
      return { rubricResult: makeRubricResult("satisfied", 0.9), costUsd: 0.05 };
    });

    const result = await evaluateWithRubric(
      handler,
      makeConfig() as any,
      TEST_RUBRIC,
      5,
    );

    // 3 handler calls * 0.10 + 3 grader calls * 0.05 = 0.45
    expect(result.costUsd).toBeCloseTo(0.45);
  });

  it("accumulates prior iteration costs and emits start/end events when a later iteration fails", async () => {
    const state = createInitialState("Test");
    const handler = vi
      .fn<() => Promise<PhaseResult>>()
      .mockResolvedValueOnce({
        success: true,
        state,
        costUsd: 0.10,
      })
      .mockResolvedValueOnce({
        success: false,
        state,
        error: "Compilation failed on retry",
        costUsd: 0.20,
      });

    mockedGradePhaseOutput.mockResolvedValue({
      rubricResult: makeRubricResult("needs_revision", 0.5),
      costUsd: 0.01,
    });

    const eventBus = new EventBus();

    const result = await evaluateWithRubric(
      handler,
      makeConfig() as any,
      TEST_RUBRIC,
      3,
      { eventBus, phase: "development" },
    );

    expect(result.success).toBe(false);
    expect(result.costUsd).toBeCloseTo(0.31);
    expect(result.totalIterations).toBe(2);
    expect(eventBus.getEvents()).toEqual([
      expect.objectContaining({
        type: "evaluation.rubric.start",
        data: expect.objectContaining({ phase: "development", rubricName: "test-rubric", iteration: 1 }),
      }),
      expect.objectContaining({
        type: "evaluation.rubric.start",
        data: expect.objectContaining({ phase: "development", rubricName: "test-rubric", iteration: 2 }),
      }),
      expect.objectContaining({
        type: "evaluation.rubric.end",
        data: expect.objectContaining({
          phase: "development",
          rubricName: "test-rubric",
          result: "failed",
          iteration: 2,
        }),
      }),
    ]);
  });
});
