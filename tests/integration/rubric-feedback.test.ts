/**
 * Integration tests for the rubric feedback loop.
 * Tests that evaluateWithRubric correctly iterates, stops, and accumulates costs
 * using realistic phase handler and grader interactions.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { evaluateWithRubric } from "../../src/evaluation/evaluate-loop.js";
import type { Rubric } from "../../src/evaluation/rubric.js";
import type { PhaseResult } from "../../src/phases/types.js";
import type { Config } from "../../src/utils/config.js";
import { createInitialState } from "../../src/state/project-state.js";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));

const { query } = await import("@anthropic-ai/claude-agent-sdk");
const mockedQuery = vi.mocked(query);

function makeGraderStream(output: {
  scores: Array<{ criterionName: string; score: number; passed: boolean; feedback: string }>;
  verdict: "satisfied" | "needs_revision" | "failed";
  overallScore: number;
  summary: string;
}) {
  return {
    [Symbol.asyncIterator]() {
      let done = false;
      return {
        async next() {
          if (done) return { value: undefined, done: true as const };
          done = true;
          return {
            value: {
              type: "result",
              subtype: "success",
              result: JSON.stringify(output),
              session_id: "grader-session",
              total_cost_usd: 0.001,
              num_turns: 1,
              structured_output: output,
            },
            done: false as const,
          };
        },
      };
    },
    close() {},
  } as any;
}

function makeConfig(): Config {
  return {
    model: "claude-sonnet-4-6",
    subagentModel: "claude-sonnet-4-6",
    selfImprove: { enabled: false, maxIterations: 50, nightlyOptimize: false },
    projectDir: ".",
    stateDir: ".autonomous-dev",
    memory: { enabled: false, maxDocuments: 500, maxDocumentSizeKb: 100 },
    rubrics: { enabled: true, maxIterations: 3 },
  } as Config;
}

const testRubric: Rubric = {
  name: "Code Quality",
  description: "Evaluates code quality across two dimensions",
  criteria: [
    { name: "completeness", description: "All features implemented", weight: 0.5, threshold: 0.7 },
    { name: "quality", description: "Code is clean and readable", weight: 0.5, threshold: 0.7 },
  ],
};

const baseState = createInitialState("build a todo app");

function makePhaseResult(overrides: Partial<PhaseResult> = {}): PhaseResult {
  return {
    success: true,
    nextPhase: "testing",
    state: baseState,
    costUsd: 0.01,
    ...overrides,
  };
}

const satisfiedGrader = makeGraderStream({
  scores: [
    { criterionName: "completeness", score: 0.9, passed: true, feedback: "All features present" },
    { criterionName: "quality", score: 0.85, passed: true, feedback: "Clean code" },
  ],
  verdict: "satisfied",
  overallScore: 0.875,
  summary: "Excellent implementation",
});

const needsRevisionGrader = makeGraderStream({
  scores: [
    { criterionName: "completeness", score: 0.5, passed: false, feedback: "Missing error handling" },
    { criterionName: "quality", score: 0.8, passed: true, feedback: "Clean code" },
  ],
  verdict: "needs_revision",
  overallScore: 0.65,
  summary: "Needs more work on error handling",
});

describe("evaluateWithRubric — rubric feedback loop integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns immediately when phase handler fails (no grader called)", async () => {
    const handler = vi.fn().mockResolvedValue(makePhaseResult({
      success: false,
      error: "Build error: missing dependency",
    }));

    const result = await evaluateWithRubric(handler, makeConfig(), testRubric, 3);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.rubricResult.verdict).toBe("failed");
    expect(result.totalIterations).toBe(1);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("returns on first iteration when grader is satisfied", async () => {
    const handler = vi.fn().mockResolvedValue(makePhaseResult());
    mockedQuery.mockReturnValue(satisfiedGrader);

    const result = await evaluateWithRubric(handler, makeConfig(), testRubric, 5);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.rubricResult.verdict).toBe("satisfied");
    expect(result.totalIterations).toBe(1);
  });

  it("retries on needs_revision and stops when satisfied", async () => {
    const handler = vi.fn().mockResolvedValue(makePhaseResult());

    // First iteration → needs_revision, second → satisfied
    mockedQuery
      .mockReturnValueOnce(needsRevisionGrader)
      .mockReturnValueOnce(satisfiedGrader);

    const result = await evaluateWithRubric(handler, makeConfig(), testRubric, 5);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(result.rubricResult.verdict).toBe("satisfied");
    expect(result.totalIterations).toBe(2);
  });

  it("stops after maxIterations even if still needs_revision", async () => {
    const handler = vi.fn().mockResolvedValue(makePhaseResult());
    mockedQuery.mockReturnValue(needsRevisionGrader);

    const result = await evaluateWithRubric(handler, makeConfig(), testRubric, 2);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(result.totalIterations).toBe(2);
    // Last grader verdict is needs_revision
    expect(result.rubricResult.verdict).toBe("needs_revision");
  });

  it("stops immediately when grader returns failed verdict", async () => {
    const handler = vi.fn().mockResolvedValue(makePhaseResult());

    mockedQuery.mockReturnValue(makeGraderStream({
      scores: [
        { criterionName: "completeness", score: 0.2, passed: false, feedback: "Barely started" },
        { criterionName: "quality", score: 0.1, passed: false, feedback: "Unreadable code" },
      ],
      verdict: "failed",
      overallScore: 0.15,
      summary: "Fundamentally wrong approach",
    }));

    const result = await evaluateWithRubric(handler, makeConfig(), testRubric, 5);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.rubricResult.verdict).toBe("failed");
    expect(result.totalIterations).toBe(1);
    // Only 1 grader call for the 1 iteration
    expect(mockedQuery).toHaveBeenCalledTimes(1);
  });

  it("accumulates cost from handler and grader across iterations", async () => {
    const handler = vi.fn().mockResolvedValue(makePhaseResult({ costUsd: 0.05 }));

    mockedQuery
      .mockReturnValueOnce(needsRevisionGrader)  // 0.001 each
      .mockReturnValueOnce(satisfiedGrader);      // 0.001 each

    const result = await evaluateWithRubric(handler, makeConfig(), testRubric, 5);

    // 2 * handler cost (0.05) + 2 * grader cost (0.001)
    expect(result.costUsd).toBeCloseTo(0.05 * 2 + 0.001 * 2, 5);
  });

  it("rubricResult includes rubric name and iteration number", async () => {
    const handler = vi.fn().mockResolvedValue(makePhaseResult());
    mockedQuery.mockReturnValue(satisfiedGrader);

    const result = await evaluateWithRubric(handler, makeConfig(), testRubric, 3);

    expect(result.rubricResult.rubricName).toBe("Code Quality");
    expect(result.rubricResult.iteration).toBe(1);
  });

  it("maxIterations=1 runs exactly once regardless of verdict", async () => {
    const handler = vi.fn().mockResolvedValue(makePhaseResult());
    mockedQuery.mockReturnValue(needsRevisionGrader);

    const result = await evaluateWithRubric(handler, makeConfig(), testRubric, 1);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.totalIterations).toBe(1);
  });
});
